/**
 * Playbase — Cloudflare Worker entrypoint (Workers + Static Assets)
 *
 * Routing:
 *   POST /api/save-reaction-score       -> ported reaction-score ingest logic
 *   POST /api/save-number-memory-score  -> shared handleSaveScore (digits, higher-is-better)
 *   POST /api/save-chimp-test-score     -> shared handleSaveScore (gridSize, higher-is-better)
 *   POST /api/save-aim-trainer-score    -> shared handleSaveScore (avgMs, lower-is-better)
 *   GET  /api/scores                    -> handleGetScores (public leaderboard/history read)
 *   everything else                     -> static assets (env.ASSETS)
 *
 * Only /api/* is routed to this Worker (see `run_worker_first` in
 * wrangler.jsonc); all other requests are served straight from static assets.
 *
 * PERSISTENCE: scores are read from and written to a D1 database bound as
 * `env.DB` (the shared `cms-db`, same physical DB content.jovylle.com uses),
 * via the `insertScore`/`queryScores` helpers. There is no longer any runtime
 * dependency on content.jovylle.com's HTTP API — the Worker owns the `/api/scores`
 * read contract directly. The single `ms` INTEGER column is reused as the generic
 * metric column for every game (reaction ms, number-memory digits, chimp-test
 * gridSize, aim-trainer avgMs all live in `ms`); `shapeScore` echoes it back under
 * each game's frontend-expected field name(s) on read.
 *
 * NOTE: the old Netlify `debug-key` and `season-reset` functions were dead
 * code and were intentionally NOT ported during the Cloudflare migration.
 */

const TOP_N = 10;
// Default page size for GET /api/scores when `limit` is missing/invalid.
const DEFAULT_SCORES_LIMIT = 10;
// Hard cap on GET /api/scores `limit` to bound query cost.
const MAX_SCORES_LIMIT = 1000;

// The set of games this Worker persists scores for. Used to validate the
// `game` query param on GET /api/scores.
const KNOWN_GAMES = new Set([
  'reaction',
  'number-memory',
  'chimp-test',
  'aim-trainer'
]);

// The single `ms` INTEGER column in `scores` is reused as the generic metric
// column for every game. Each game's frontend (and, for some, the internal
// isNewRecord comparator) reads the value under a different field name, so
// `shapeScore` echoes `ms` back under these alias(es) per game:
//   - reaction     -> none (reads raw `ms`)
//   - number-memory-> `digits`   (frontend + comparator)
//   - chimp-test   -> `gridSize` (comparator) AND `grid_size` (frontend);
//                     both are emitted because they diverge
//   - aim-trainer  -> `avgMs`    (frontend + comparator)
const SCORE_METRIC_ALIASES = {
  reaction: [],
  'number-memory': ['digits'],
  'chimp-test': ['gridSize', 'grid_size'],
  'aim-trainer': ['avgMs']
};
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

    if (url.pathname === '/api/scores') {
      return handleGetScores(request, env);
    }

    // Not an API route -> fall through to static assets.
    return env.ASSETS.fetch(request);
  }
};

/**
 * Validate a reaction-time score, persist it to the D1 `scores` table
 * (`env.DB`), then read back the leaderboard sample to compute
 * isNewRecord / position / percentile. Behavior, status codes, and response
 * shape match the previous HTTP-proxy implementation exactly; only the
 * persistence layer changed (D1 insert/query instead of content-API POST/GET).
 */
async function handleSaveReactionScore(request, env) {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

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
    // Primary key for the `scores` row. Web Crypto's getRandomValues over 4
    // bytes always yields exactly 8 lowercase hex chars (^[a-f0-9]{8}$).
    const id = randomHex8();

    const newScore = {
      ms,
      timestamp,
      id,
      playerName: finalName,
      playerId: finalId
    };

    // 1. Persist the score to the D1 `scores` table (ms is the generic metric
    // column). The id/timestamp we generated above are the source of truth.
    await insertScore(env, {
      id,
      game: 'reaction',
      ms,
      playerName: finalName,
      playerId: finalId,
      createdAt: timestamp
    });

    // 2. Read back a large sample of the leaderboard (sorted best-first, i.e.
    // ascending ms — lower is better for reaction) to compute
    // isNewRecord/position, and — reaction-only — a percentile. A single
    // larger read covers both the top-N view and the percentile sample.
    const rankedTop = await queryScores(env, {
      game: 'reaction',
      sort: 'top',
      direction: 'asc',
      limit: PERCENTILE_SAMPLE_SIZE
    });

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
  formatMessage: (digits) => `${digits} digits`,
  // Higher digit count is better -> `sort=top` orders ms (the metric column)
  // descending. Mirrors the direction encoded in the isNewRecord comparator.
  BETTER_DIRECTION: 'desc'
};

const CHIMP_TEST_CONFIG = {
  game: 'chimp-test',
  metricName: 'gridSize',
  validateMetric: (gridSize) =>
    !Number.isInteger(gridSize) || gridSize < 4 || gridSize > 35
      ? 'Invalid grid size. Must be an integer between 4-35.'
      : null,
  isNewRecord: (gridSize, topScore) => gridSize >= (topScore?.gridSize ?? -Infinity),
  formatMessage: (gridSize) => `grid size ${gridSize}`,
  // Higher grid size is better -> `sort=top` orders ms descending.
  BETTER_DIRECTION: 'desc'
};

const AIM_TRAINER_CONFIG = {
  game: 'aim-trainer',
  metricName: 'avgMs',
  validateMetric: (avgMs) =>
    !Number.isInteger(avgMs) || avgMs < 100 || avgMs > 3000
      ? 'Invalid average time. Must be an integer between 100-3000ms.'
      : null,
  isNewRecord: (avgMs, topScore) => avgMs <= (topScore?.avgMs ?? Infinity),
  formatMessage: (avgMs) => `${avgMs}ms average`,
  // Lower average time is better -> `sort=top` orders ms ascending.
  BETTER_DIRECTION: 'asc'
};

// Map of game name -> its config, for looking up BETTER_DIRECTION from routes
// that don't already hold a config (e.g. handleGetScores). reaction has no
// config object; its direction is a literal 'asc' (lower ms is better).
const GAME_CONFIGS = {
  'number-memory': NUMBER_MEMORY_CONFIG,
  'chimp-test': CHIMP_TEST_CONFIG,
  'aim-trainer': AIM_TRAINER_CONFIG
};

/** Best-first sort direction on the `ms` metric column for a given game. */
function directionForGame(game) {
  if (game === 'reaction') return 'asc';
  return GAME_CONFIGS[game]?.BETTER_DIRECTION || 'asc';
}

/**
 * Shared /api/save-<game>-score handler for the newer games (number-memory,
 * chimp-test, aim-trainer). Follows `handleSaveReactionScore`'s exact
 * structure: validate metric -> sanitize name/id -> rate-limit -> insert to
 * D1 -> query top-N from D1 -> compute isNewRecord/position -> respond.
 * `config` supplies the game-specific bits (see the *_CONFIG objects above).
 */
async function handleSaveScore(request, env, config) {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const {
    game,
    metricName,
    validateMetric,
    isNewRecord: computeIsNewRecord,
    formatMessage,
    BETTER_DIRECTION
  } = config;

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
    // Primary key for the `scores` row. Web Crypto's getRandomValues over 4
    // bytes always yields exactly 8 lowercase hex chars (^[a-f0-9]{8}$).
    const id = randomHex8();

    const newScore = {
      [metricName]: metricValue,
      timestamp,
      id,
      playerName: finalName,
      playerId: finalId
    };

    // 1. Persist the score to the D1 `scores` table. The metric value lives in
    // the generic `ms` column; the id/timestamp we generated are source of truth.
    await insertScore(env, {
      id,
      game,
      ms: metricValue,
      playerName: finalName,
      playerId: finalId,
      createdAt: timestamp
    });

    // 2. Read back the top-N leaderboard (best-first per this game's direction)
    // to compute isNewRecord/position.
    const rankedTop = await queryScores(env, {
      game,
      sort: 'top',
      direction: BETTER_DIRECTION,
      limit: TOP_N
    });

    // `sort=top` is metric-agnostic: always "best first" for whatever game is
    // queried (per BETTER_DIRECTION), mirroring reaction's ascending-by-ms
    // contract. `shapeScore` echoes `ms` under this game's expected alias, so
    // the comparator's `topScore?.<metric>` read resolves correctly.
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
 * Public read endpoint: GET /api/scores?game=<name>&sort=top|recent&limit=<n>.
 *
 * Serves the leaderboard/history directly from D1 (no content.jovylle.com
 * dependency). `game` must be one of KNOWN_GAMES (400 otherwise). `sort`
 * defaults to `top` and must be `top` or `recent` (400 otherwise). `limit`
 * defaults to DEFAULT_SCORES_LIMIT, is clamped to [1, MAX_SCORES_LIMIT], and
 * falls back to the default for missing/non-numeric input. For `sort=top`, the
 * best-first direction is resolved per game; `sort=recent` is always newest-first.
 * Each returned score is shaped via `shapeScore` (raw `ms` plus per-game aliases).
 */
async function handleGetScores(request, env) {
  if (request.method !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  try {
    const url = new URL(request.url);

    const game = url.searchParams.get('game');
    if (!game || !KNOWN_GAMES.has(game)) {
      return json(400, { error: 'Invalid or missing game parameter.' });
    }

    const sort = url.searchParams.get('sort') || 'top';
    if (sort !== 'top' && sort !== 'recent') {
      return json(400, { error: 'Invalid sort parameter. Must be "top" or "recent".' });
    }

    const parsedLimit = parseInt(url.searchParams.get('limit'), 10);
    let limit = Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_SCORES_LIMIT;
    if (limit < 1) limit = 1;
    if (limit > MAX_SCORES_LIMIT) limit = MAX_SCORES_LIMIT;

    const direction = sort === 'top' ? directionForGame(game) : 'asc';
    const scores = await queryScores(env, { game, sort, direction, limit });

    return json(200, { scores });
  } catch (error) {
    console.error('Function error:', error);
    // Do not leak internal error details (D1, config) to clients.
    return json(500, { error: 'Failed to fetch scores' });
  }
}

/**
 * Shape a raw D1 `scores` row for consumption by frontends and the internal
 * isNewRecord comparators. Returns the row's canonical fields plus per-game
 * aliases of the generic `ms` metric column (see SCORE_METRIC_ALIASES).
 *
 * @param {string} game
 * @param {{ id: string, game?: string, ms: number, player_name: string, player_id: string, created_at: string }} row
 */
function shapeScore(game, row) {
  const shaped = {
    id: row.id,
    game: row.game ?? game,
    ms: row.ms,
    player_name: row.player_name,
    player_id: row.player_id,
    created_at: row.created_at
  };
  for (const alias of SCORE_METRIC_ALIASES[game] || []) {
    shaped[alias] = row.ms;
  }
  return shaped;
}

/**
 * Insert one score row into the shared D1 `scores` table. The metric value is
 * stored in the generic `ms` INTEGER column (CHECK ms > 0 — all game metrics
 * are positive integers, enforced by each route's validation).
 */
async function insertScore(env, { id, game, ms, playerName, playerId, createdAt }) {
  await env.DB
    .prepare(
      'INSERT INTO scores (id, game, ms, player_name, player_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(id, game, ms, playerName, playerId, createdAt)
    .run();
}

/**
 * Query scores for a game from D1, returning rows shaped via `shapeScore`.
 *
 * `sort=recent` orders by created_at DESC (newest-first). `sort=top` orders by
 * the `ms` metric column, best-first per `direction` ('asc' = lower is better,
 * 'desc' = higher is better). ORDER BY direction can't be parameter-bound in
 * D1, so it's selected from a fixed set of literal SQL strings (never from user
 * input) to keep the query injection-safe. `game` and `limit` are param-bound.
 */
async function queryScores(env, { game, sort, direction, limit }) {
  let orderBy;
  if (sort === 'recent') {
    orderBy = 'created_at DESC';
  } else {
    orderBy = direction === 'desc' ? 'ms DESC' : 'ms ASC';
  }

  const { results } = await env.DB
    .prepare(
      `SELECT id, game, ms, player_name, player_id, created_at FROM scores WHERE game = ? ORDER BY ${orderBy} LIMIT ?`
    )
    .bind(game, limit)
    .all();

  return (results || []).map((row) => shapeScore(game, row));
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
