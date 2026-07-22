/**
 * Playbase — Cloudflare Worker entrypoint (Workers + Static Assets)
 *
 * Routing:
 *   POST /api/save-reaction-score       -> ported reaction-score ingest logic
 *   POST /api/save-number-memory-score  -> shared handleSaveScore (digits, higher-is-better)
 *   POST /api/save-chimp-test-score     -> shared handleSaveScore (gridSize, higher-is-better)
 *   POST /api/save-aim-trainer-score    -> shared handleSaveScore (avgMs, lower-is-better)
 *   everything else                     -> static assets (env.ASSETS)
 *
 * Only /api/* is routed to this Worker (see `run_worker_first` in
 * wrangler.jsonc); all other requests are served straight from static assets.
 *
 * NOTE: the old Netlify `debug-key` and `season-reset` functions were dead
 * code and were intentionally NOT ported during the Cloudflare migration.
 */

const DEFAULT_CONTENT_API_BASE = 'https://content.jovylle.com';
const TOP_N = 10;
// Reaction-only: sample size used to compute the percentile field. Large
// enough to be a meaningful percentile estimate without fetching the entire
// leaderboard on every submission.
const PERCENTILE_SAMPLE_SIZE = 1000;

// --- Rate limiting / input hardening tunables ---
// Minimum gap between two accepted submissions from the same key.
const RATE_LIMIT_COOLDOWN_MS = 5000;
// Generous per-key daily ceiling — meant to blunt scripted spam, not real play.
const RATE_LIMIT_DAILY_CAP = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
// Cloudflare KV enforces a 60s minimum on expirationTtl.
const KV_MIN_TTL_SECONDS = 60;
// Max accepted lengths for free-form player-supplied fields.
const MAX_PLAYER_NAME_LEN = 32;
const MAX_PLAYER_ID_LEN = 128;
// Control chars (incl. DEL) are stripped from player-supplied strings.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/save-reaction-score') {
      return handleSaveReactionScore(request, env);
    }

    if (url.pathname === '/api/save-number-memory-score') {
      return handleSaveScore(request, env, NUMBER_MEMORY_CONFIG);
    }

    if (url.pathname === '/api/save-chimp-test-score') {
      return handleSaveScore(request, env, CHIMP_TEST_CONFIG);
    }

    if (url.pathname === '/api/save-aim-trainer-score') {
      return handleSaveScore(request, env, AIM_TRAINER_CONFIG);
    }

    // Not an API route -> fall through to static assets.
    return env.ASSETS.fetch(request);
  }
};

/**
 * Validate a reaction-time score, forward it to content.jovylle.com's
 * D1-backed /api/scores resource, then read back the top-N leaderboard to
 * compute isNewRecord / position. Mirrors the previous Netlify function's
 * behavior, status codes, and response shape exactly.
 */
async function handleSaveReactionScore(request, env) {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const contentApiBase = env.CONTENT_API_BASE || DEFAULT_CONTENT_API_BASE;

  try {
    const { ms, playerName, playerId } = await request.json();

    if (!ms || typeof ms !== 'number' || ms < 80 || ms > 1000) {
      return json(400, {
        error: 'Invalid reaction time. Must be between 80-1000ms.'
      });
    }

    // Sanitize free-form player-supplied fields: strip control chars, trim,
    // and cap length. A missing value falls back to Anonymous/unknown, but a
    // name that was provided yet sanitizes to empty (only control chars /
    // whitespace) is rejected outright.
    const nameProvided = typeof playerName === 'string' && playerName.length > 0;
    const sanitizedName = sanitizeField(playerName, MAX_PLAYER_NAME_LEN);
    if (nameProvided && sanitizedName.length === 0) {
      return json(400, { error: 'Invalid player name.' });
    }
    const finalName = sanitizedName || 'Anonymous';
    const sanitizedId = sanitizeField(playerId, MAX_PLAYER_ID_LEN);
    const finalId = sanitizedId || 'unknown';

    // Rate-limit on the (sanitized) playerId when present, else on the client
    // IP. Fails open on infrastructure errors so real players are never locked
    // out by a KV outage.
    const ip = request.headers.get('cf-connecting-ip') || '';
    const rateResult = await checkRateLimit(env, { playerId: sanitizedId, ip });
    if (!rateResult.allowed) {
      const message =
        rateResult.reason === 'daily-cap'
          ? 'Daily submission limit reached. Please try again tomorrow.'
          : 'Slow down! Please wait a few seconds before submitting another score.';
      return json(429, { error: message });
    }

    const timestamp = new Date().toISOString();
    // The sibling API's schema strictly requires ^[a-f0-9]{8}$. Web Crypto's
    // getRandomValues over 4 bytes always yields exactly 8 lowercase hex chars.
    const id = randomHex8();

    const newScore = {
      ms,
      timestamp,
      id,
      playerName: finalName,
      playerId: finalId
    };

    if (!env.CONTENT_ADMIN_PASSWORD) {
      throw new Error('CONTENT_ADMIN_PASSWORD is not configured');
    }

    // btoa is the Workers-native base64 encoder (Node's Buffer isn't available
    // by default in Workers).
    const authHeader = `Basic ${btoa(`admin:${env.CONTENT_ADMIN_PASSWORD}`)}`;

    // 1. Submit the score to the content API's `reaction` scores.
    const ingestResponse = await fetch(`${contentApiBase}/api/scores`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        game: 'reaction',
        ms,
        playerName: newScore.playerName,
        playerId: newScore.playerId
      })
    });

    if (!ingestResponse.ok) {
      const errorBody = await ingestResponse.text();
      console.error('Content API rejected score:', ingestResponse.status, errorBody);
      throw new Error(`Content API request failed: ${ingestResponse.status}`);
    }

    const inserted = await ingestResponse.json();
    // Use the API's own generated record (id/created_at) as source of truth.
    newScore.id = inserted.id || id;
    newScore.timestamp = inserted.created_at || timestamp;

    // 2. Fetch a large sample of the leaderboard (sorted best-first, i.e.
    // ascending ms) to compute isNewRecord/position, and — reaction-only —
    // a percentile. A single larger fetch covers both the top-N view and the
    // percentile sample, avoiding a second round-trip.
    const topResponse = await fetch(
      `${contentApiBase}/api/scores?game=reaction&sort=top&limit=${PERCENTILE_SAMPLE_SIZE}`
    );

    if (!topResponse.ok) {
      const errorBody = await topResponse.text();
      console.error('Content API rejected top-scores fetch:', topResponse.status, errorBody);
      throw new Error(`Content API request failed: ${topResponse.status}`);
    }

    const topResult = await topResponse.json();
    const rankedTop = Array.isArray(topResult.scores) ? topResult.scores : [];

    // Fastest overall is a new record; position is this score's 1-indexed rank
    // within the sampled leaderboard (already sorted ascending by ms).
    const isNewRecord = ms <= (rankedTop[0]?.ms ?? Infinity);
    const position = rankedTop.findIndex((score) => score.id === newScore.id) + 1;

    // Percentile: what fraction of the sampled leaderboard this score beats.
    // Only meaningful if the score was actually found within the sample — if
    // the sample was capped and this score didn't rank inside it, omit the
    // field rather than report a misleading number.
    const percentile =
      position > 0 && rankedTop.length > 0
        ? Math.round((1 - position / rankedTop.length) * 100)
        : null;

    return json(200, {
      success: true,
      score: newScore,
      isNewRecord,
      position: position || null,
      percentile,
      message: isNewRecord
        ? `🔥 NEW RECORD! ${ms}ms`
        : position
          ? `Nice! Ranked #${position} with ${ms}ms`
          : `${ms}ms recorded`
    });
  } catch (error) {
    console.error('Function error:', error);
    // Do not leak internal error details (KV, upstream API, config) to clients.
    return json(500, { error: 'Failed to save score' });
  }
}

/**
 * Per-game config consumed by the shared `handleSaveScore` handler below.
 * Mirrors the pieces of `handleSaveReactionScore` that vary game-to-game:
 * the metric field name/validation, and how "isNewRecord" is derived from
 * whichever direction (higher/lower) counts as "better" for that metric.
 */
const NUMBER_MEMORY_CONFIG = {
  game: 'number-memory',
  metricName: 'digits',
  validateMetric: (digits) =>
    !Number.isInteger(digits) || digits < 1 || digits > 20
      ? 'Invalid digit count. Must be an integer between 1-20.'
      : null,
  isNewRecord: (digits, topScore) => digits >= (topScore?.digits ?? -Infinity),
  formatMessage: (digits) => `${digits} digits`
};

const CHIMP_TEST_CONFIG = {
  game: 'chimp-test',
  metricName: 'gridSize',
  validateMetric: (gridSize) =>
    !Number.isInteger(gridSize) || gridSize < 4 || gridSize > 35
      ? 'Invalid grid size. Must be an integer between 4-35.'
      : null,
  isNewRecord: (gridSize, topScore) => gridSize >= (topScore?.gridSize ?? -Infinity),
  formatMessage: (gridSize) => `grid size ${gridSize}`
};

const AIM_TRAINER_CONFIG = {
  game: 'aim-trainer',
  metricName: 'avgMs',
  validateMetric: (avgMs) =>
    !Number.isInteger(avgMs) || avgMs < 100 || avgMs > 3000
      ? 'Invalid average time. Must be an integer between 100-3000ms.'
      : null,
  isNewRecord: (avgMs, topScore) => avgMs <= (topScore?.avgMs ?? Infinity),
  formatMessage: (avgMs) => `${avgMs}ms average`
};

/**
 * Shared /api/save-<game>-score handler for the newer games (number-memory,
 * chimp-test, aim-trainer). Follows `handleSaveReactionScore`'s exact
 * structure: validate metric -> sanitize name/id -> rate-limit -> POST to
 * content API -> GET top-N -> compute isNewRecord/position -> respond.
 * `config` supplies the game-specific bits (see the *_CONFIG objects above).
 */
async function handleSaveScore(request, env, config) {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const contentApiBase = env.CONTENT_API_BASE || DEFAULT_CONTENT_API_BASE;
  const { game, metricName, validateMetric, isNewRecord: computeIsNewRecord, formatMessage } =
    config;

  try {
    const body = await request.json();
    const metricValue = body[metricName];

    const validationError = validateMetric(metricValue);
    if (validationError) {
      return json(400, { error: validationError });
    }

    // Sanitize free-form player-supplied fields: strip control chars, trim,
    // and cap length. A missing value falls back to Anonymous/unknown, but a
    // name that was provided yet sanitizes to empty (only control chars /
    // whitespace) is rejected outright.
    const { playerName, playerId } = body;
    const nameProvided = typeof playerName === 'string' && playerName.length > 0;
    const sanitizedName = sanitizeField(playerName, MAX_PLAYER_NAME_LEN);
    if (nameProvided && sanitizedName.length === 0) {
      return json(400, { error: 'Invalid player name.' });
    }
    const finalName = sanitizedName || 'Anonymous';
    const sanitizedId = sanitizeField(playerId, MAX_PLAYER_ID_LEN);
    const finalId = sanitizedId || 'unknown';

    // Rate-limit on the (sanitized) playerId when present, else on the client
    // IP. Fails open on infrastructure errors so real players are never locked
    // out by a KV outage.
    const ip = request.headers.get('cf-connecting-ip') || '';
    const rateResult = await checkRateLimit(env, { playerId: sanitizedId, ip });
    if (!rateResult.allowed) {
      const message =
        rateResult.reason === 'daily-cap'
          ? 'Daily submission limit reached. Please try again tomorrow.'
          : 'Slow down! Please wait a few seconds before submitting another score.';
      return json(429, { error: message });
    }

    const timestamp = new Date().toISOString();
    // The sibling API's schema strictly requires ^[a-f0-9]{8}$. Web Crypto's
    // getRandomValues over 4 bytes always yields exactly 8 lowercase hex chars.
    const id = randomHex8();

    const newScore = {
      [metricName]: metricValue,
      timestamp,
      id,
      playerName: finalName,
      playerId: finalId
    };

    if (!env.CONTENT_ADMIN_PASSWORD) {
      throw new Error('CONTENT_ADMIN_PASSWORD is not configured');
    }

    // btoa is the Workers-native base64 encoder (Node's Buffer isn't available
    // by default in Workers).
    const authHeader = `Basic ${btoa(`admin:${env.CONTENT_ADMIN_PASSWORD}`)}`;

    // 1. Submit the score to the content API's `<game>` scores.
    const ingestResponse = await fetch(`${contentApiBase}/api/scores`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        game,
        [metricName]: metricValue,
        playerName: newScore.playerName,
        playerId: newScore.playerId
      })
    });

    if (!ingestResponse.ok) {
      const errorBody = await ingestResponse.text();
      console.error('Content API rejected score:', ingestResponse.status, errorBody);
      throw new Error(`Content API request failed: ${ingestResponse.status}`);
    }

    const inserted = await ingestResponse.json();
    // Use the API's own generated record (id/created_at) as source of truth.
    newScore.id = inserted.id || id;
    newScore.timestamp = inserted.created_at || timestamp;

    // 2. Fetch the top-N leaderboard to compute isNewRecord/position.
    const topResponse = await fetch(
      `${contentApiBase}/api/scores?game=${game}&sort=top&limit=${TOP_N}`
    );

    if (!topResponse.ok) {
      const errorBody = await topResponse.text();
      console.error('Content API rejected top-scores fetch:', topResponse.status, errorBody);
      throw new Error(`Content API request failed: ${topResponse.status}`);
    }

    const topResult = await topResponse.json();
    const rankedTop = Array.isArray(topResult.scores) ? topResult.scores : [];

    // `sort=top` is assumed metric-agnostic: always "best first" for whatever
    // game is queried, mirroring reaction's ascending-by-ms contract.
    const isNewRecord = computeIsNewRecord(metricValue, rankedTop[0]);
    const position = rankedTop.findIndex((score) => score.id === newScore.id) + 1;

    return json(200, {
      success: true,
      score: newScore,
      isNewRecord,
      position: position || null,
      message: isNewRecord
        ? `🔥 NEW RECORD! ${formatMessage(metricValue)}`
        : position
          ? `Nice! Ranked #${position} with ${formatMessage(metricValue)}`
          : `${formatMessage(metricValue)} recorded`
    });
  } catch (error) {
    console.error('Function error:', error);
    // Do not leak internal error details (KV, upstream API, config) to clients.
    return json(500, { error: 'Failed to save score' });
  }
}

/**
 * Strip control characters, trim, and length-cap a free-form player-supplied
 * string. Non-string input yields ''. Callers decide fallback vs rejection.
 */
function sanitizeField(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, '').trim().slice(0, maxLen);
}

/**
 * Shared, game-agnostic score-submission rate limiter. Reused by every
 * /api/save-<game>-score route.
 *
 * Keys on `playerId` when present/non-empty, else on the client `ip`. State is
 * a single JSON KV entry per key: { lastTs, dayCount, dayStart }.
 *
 * Enforces two limits:
 *   - a short cooldown between accepted submissions (RATE_LIMIT_COOLDOWN_MS)
 *   - a rolling per-day cap (RATE_LIMIT_DAILY_CAP), the window anchored to the
 *     first submission of the day and TTL'd to roll over ~24h later.
 *
 * Fails OPEN: if the KV binding is absent (e.g. local dev without KV) or any
 * KV op throws, the request is allowed and the error is logged. This never
 * fails closed, so an infra problem can't lock out legitimate players. Genuine
 * rate-limit hits (cooldown / daily-cap) still return { allowed: false }.
 *
 * @param {*} env - Worker env (expects env.SCORE_RATE_LIMIT KV binding).
 * @param {{ playerId?: string, ip?: string }} identity
 * @returns {Promise<{ allowed: boolean, reason?: 'cooldown' | 'daily-cap' }>}
 */
async function checkRateLimit(env, { playerId, ip } = {}) {
  const kv = env && env.SCORE_RATE_LIMIT;
  if (!kv) {
    // No binding (local dev / not yet provisioned) -> fail open.
    console.warn('SCORE_RATE_LIMIT KV binding not configured; skipping rate limit');
    return { allowed: true };
  }

  const rawKey = (playerId && playerId.trim()) || (ip && ip.trim()) || 'unknown';
  const key = `rl:${rawKey}`;
  const now = Date.now();

  try {
    const existingRaw = await kv.get(key);
    let state = existingRaw ? JSON.parse(existingRaw) : null;

    // Start a fresh daily window if none exists or the current one has elapsed.
    if (!state || typeof state.dayStart !== 'number' || now - state.dayStart >= DAY_MS) {
      state = { lastTs: 0, dayCount: 0, dayStart: now };
    }

    // Cooldown: reject without mutating state (preserves the original lastTs).
    if (state.lastTs && now - state.lastTs < RATE_LIMIT_COOLDOWN_MS) {
      return { allowed: false, reason: 'cooldown' };
    }

    // Daily ceiling.
    if (state.dayCount >= RATE_LIMIT_DAILY_CAP) {
      return { allowed: false, reason: 'daily-cap' };
    }

    // Accept: record this submission and persist with a TTL that expires the
    // key at the end of the current day window.
    state.lastTs = now;
    state.dayCount += 1;
    const ttlSeconds = Math.max(
      KV_MIN_TTL_SECONDS,
      Math.ceil((state.dayStart + DAY_MS - now) / 1000)
    );
    await kv.put(key, JSON.stringify(state), { expirationTtl: ttlSeconds });

    return { allowed: true };
  } catch (err) {
    // Infrastructure failure (KV outage, parse error, etc.) -> fail open.
    console.error('Rate limit check failed (failing open):', err);
    return { allowed: true };
  }
}

/**
 * Build a JSON Response. The `Access-Control-Allow-Origin: *` header is emitted
 * on every API response (the frontend fetches this endpoint and relies on CORS).
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*' // Adjust for your domain
    }
  });
}

/** Exactly 8 lowercase hex characters (matches ^[a-f0-9]{8}$). */
function randomHex8() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
