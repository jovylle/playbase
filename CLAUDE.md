# Playbase — Claude Code Instructions

## What this project is

Mini-game platform. Root `index.html` is a lightweight hub (card grid) linking to each game's own folder; each game is a single self-contained HTML file with its own inline styles (deliberately not sharing a design system across pages). Players play browser games; scores are read and written by the Cloudflare Worker directly against a D1 database bound as `DB` (the shared `cms-db`, same physical database `content.jovylle.com` uses). The Worker owns the `/api/scores` read contract itself — there is no longer any runtime dependency on `content.jovylle.com`'s HTTP API for scores. Some legacy game data still lives as JSON files committed to this repo via the GitHub App API.

Live URL: **https://fast.jovylle.com**

## Games (4 total)

- **Reaction Tester** (`reaction/index.html`) — Best of 5 rounds with false-start detection, averaged `ms` score (lower is better), percentile stat (`Faster than X% of players`), share button.
- **Number Memory** (`number-memory/index.html`) — recall growing digit sequences, `digits` score (higher is better).
- **Chimp Test** (`chimp-test/index.html`) — click numbered tiles in order from memory, `gridSize` score (higher is better).
- **Aim Trainer** (`aim-trainer/index.html`) — click 30 targets, `avgMs` score (lower is better).

`history.html` is shared across all 4 games via a `?game=<name>` query param (defaults to `reaction`).

## Stack

- **Frontend**: Vanilla HTML/CSS/JS, single-file per game (`<game>/index.html`), hub at root `index.html`, shared `history.html`
- **Backend**: Cloudflare Worker (`src/index.js`) handling `/api/*` routes; everything else served as static assets
- **Database**: Cloudflare D1 bound as `DB` in `src/index.js` — the shared `cms-db` (database_id `8ba72fee-60b8-47b6-b4a8-db28722ead1a`), same physical DB `content.jovylle.com` uses. Scores live in a single `scores` table (`id, game, ms, player_name, player_id, created_at`); the `ms` INTEGER column is reused as the generic metric column for every game (reaction `ms`, number-memory `digits`, chimp-test `gridSize`, aim-trainer `avgMs` all stored in `ms`). Reads/writes go through the `insertScore`/`queryScores` helpers — no HTTP proxy through `content.jovylle.com`. Legacy GitHub Contents API writes still used for other JSON files committed directly to this repo.
- **Rate limiting**: Cloudflare KV (`SCORE_RATE_LIMIT` binding) backs a shared `checkRateLimit(env, { playerId, ip })` helper in `src/index.js` — 5s cooldown + 100/day cap per key (`playerId`, falls back to `cf-connecting-ip`). Fails open on KV errors so an infra hiccup never locks out real players.
- **Auth**: GitHub App JWT → installation access token (RS256) for legacy writes. Score writes no longer authenticate to an external API — they insert straight into the bound D1 database, so no per-request credential is involved.
- **Deploy**: Cloudflare Workers + Static Assets (`wrangler deploy`), auto-deploy on push to `master` via `.github/workflows/deploy.yml`
- **Content ecosystem**: `content.jovylle.com` — retrieve/store portfolio and project metadata. It no longer sits in the score read/write path; Playbase binds the shared `cms-db` directly. `content.jovylle.com` continues to use the same database independently.
- **Public read contract**: `GET /api/scores?game=<name>&sort=top|recent&limit=<n>` is served directly by the Playbase Worker (`handleGetScores`) from D1. `game` ∈ {reaction, number-memory, chimp-test, aim-trainer} (400 otherwise); `sort` defaults to `top` (`top`|`recent`, 400 otherwise); `limit` defaults to 10, clamped to [1, 1000]. Response: `{ scores: [...] }` where each score has `id, game, ms, player_name, player_id, created_at` plus the game's frontend alias (`digits`/`gridSize`+`grid_size`/`avgMs`). Usable by other tools independent of `content.jovylle.com`.

## Data layer

Scores live in the D1 `scores` table (shared `cms-db`, bound as `DB`):

```sql
CREATE TABLE scores (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  ms INTEGER NOT NULL CHECK (ms > 0),   -- generic metric column (see below)
  player_name TEXT NOT NULL,
  player_id TEXT NOT NULL,
  created_at TEXT NOT NULL              -- ISO8601
)
```

The single `ms` column stores every game's metric (reaction `ms`, number-memory `digits`, chimp-test `gridSize`, aim-trainer `avgMs`). On read, `shapeScore(game, row)` in `src/index.js` echoes `ms` back under each game's expected alias so frontends keep working unchanged — reaction reads raw `ms`; number-memory reads `digits`; aim-trainer reads `avgMs`; chimp-test's frontend reads snake_case `grid_size` while the internal `isNewRecord` comparator reads camelCase `gridSize`, so BOTH are emitted for chimp-test.

Save-response score object shape (camelCase, unchanged from before):
```json
{ "ms": 142, "timestamp": "ISO8601", "id": "hex8", "playerName": "str", "playerId": "fingerprint_str" }
```

Legacy per-game JSON files (`reaction/latest.json`, `top.json`, `history.json`, `history.ndjson`) are dead/unread by the Worker — the D1 table is authoritative.

## Environment variables / secrets (Cloudflare)

Secrets are set with `wrangler secret put <NAME>` (not committed). Plain vars can
live under `vars` in `wrangler.jsonc`.

```
CONTENT_ADMIN_PASSWORD   # secret — NO LONGER USED by the score routes (D1-direct now).
                         # Leave the Cloudflare secret in place; just unused by src/index.js.
CONTENT_API_BASE         # NO LONGER USED by the score routes. Safe to leave unset.
```

Legacy GitHub App vars (`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`,
`GITHUB_PRIVATE_KEY`) are only needed if a legacy GitHub-Contents write path is
reintroduced; the score flow does not use them.

`wrangler.jsonc` binds a KV namespace and a D1 database:

```
kv_namespaces: [{ binding: "SCORE_RATE_LIMIT", id: "...", preview_id: "..." }]
d1_databases:  [{ binding: "DB", database_name: "cms-db", database_id: "8ba72fee-60b8-47b6-b4a8-db28722ead1a" }]
```

The KV namespace is used exclusively by the rate-limit helper in `src/index.js`. The `DB` binding is the shared `cms-db` and is the sole persistence layer for scores (`insertScore`/`queryScores`).

## Key conventions

- **New game = new folder** under the repo root (e.g. `memory/`, `typing/`) with its own JSON data files and a matching `/api/save-<game>-score` route added to the Worker in `src/index.js`.
- Add the game's JSON schema to `schemas/<game>.schema.json`.
- Valid score range is validated both frontend and backend; reject outside the game-specific range.
- Commit messages follow: `update(<game>): <playerName> scored <value><unit>`
- No npm build step — frontend is pure HTML. Keep it that way unless a game genuinely needs a bundler.
- `history.json` grows unboundedly — consider season-reset workflow (see `.github/workflows/season-reset.yml`) when records exceed ~500.

## GitHub API write pattern (legacy games only)

1. GET file → extract `sha` + decode base64 content
2. Mutate in-memory
3. PUT file with updated content + same `sha` (prevents conflicts)
4. All three files (latest, top, history) are updated in `Promise.all`

## Score write pattern

The `POST /api/save-reaction-score` route in `src/index.js` is the original, standalone handler (kept for the reaction game's Best-of-5 + percentile logic). The 3 newer games (`number-memory`, `chimp-test`, `aim-trainer`) share a generic `handleSaveScore(request, env, config)` handler, parameterized per game by a `*_CONFIG` object (`game` name, `metricName`, `validateMetric`, `isNewRecord` comparator, `formatMessage`, `BETTER_DIRECTION`) — see `NUMBER_MEMORY_CONFIG`/`CHIMP_TEST_CONFIG`/`AIM_TRAINER_CONFIG` in `src/index.js`. Both paths persist directly to D1: after validation/sanitization/rate-limiting, they `insertScore(env, {...})` (metric value stored in the `ms` column), then `queryScores(env, { game, sort: 'top', direction, limit })` to read back the best-first leaderboard and compute `isNewRecord`/`position` (+ percentile for reaction). `sort=top` is metric-agnostic — always "best first" per each game's `BETTER_DIRECTION` (reaction/aim-trainer `asc` = lower is better; number-memory/chimp-test `desc` = higher is better). Every route calls the shared `checkRateLimit`/`sanitizeField` helpers first. The save-response `score` object keeps its camelCase shape (`playerName`/`playerId`/`timestamp`); only the leaderboard read (`GET /api/scores`, shaped via `shapeScore`) returns snake_case + aliases. The frontend (`<game>/index.html`, `history.html`) reads directly from `/api/scores` (relative path, same-origin) as well.

## Adding a new game checklist

- [ ] `schemas/<game>.schema.json` (model on `schemas/reaction.schema.json`; state explicitly whether higher or lower is "better" for the metric — this drives the `isNewRecord` comparator)
- [ ] Add a `<game>_CONFIG` object (including `BETTER_DIRECTION`) and a routing check in `src/index.js` (reuse `handleSaveScore`, `checkRateLimit`, `sanitizeField`, `insertScore`, `queryScores` — don't duplicate them)
- [ ] Add the game to `KNOWN_GAMES` and to `SCORE_METRIC_ALIASES` in `src/index.js` (the alias(es) must exactly match the field name(s) the game's frontend reads off `/api/scores` — verify by grep, don't assume; emit multiple aliases if the frontend and the `isNewRecord` comparator diverge, as chimp-test does with `grid_size`/`gridSize`)
- [ ] Add the game to `GAME_CONFIGS` so `directionForGame` resolves its `sort=top` direction
- [ ] `<game>/index.html` — single self-contained file, own inline styles, screen-toggle pattern (main/game/result), "← All games" link to `/`, link to `history.html?game=<name>`, share button on the result screen
- [ ] New card in the hub's `index.html` card grid
- [ ] Update `PROJECT_OVERVIEW.md`

Legacy per-game JSON files (`<game>/latest.json`, `top.json`, `history.json`) are **not** part of this pattern — the reaction game's copies are dead/unread by the Worker, and no new game needs them.
