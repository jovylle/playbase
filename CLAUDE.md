# Playbase — Claude Code Instructions

## What this project is

Mini-game platform. Root `index.html` is a lightweight hub (card grid) linking to each game's own folder; each game is a single self-contained HTML file with its own inline styles (deliberately not sharing a design system across pages). Players play browser games; scores are written via a Cloudflare Worker to a D1-backed `/api/scores` resource on `content.jovylle.com`. Some legacy game data still lives as JSON files committed to this repo via the GitHub App API, but new writes for all games go through the content API, not GitHub Contents.

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
- **Database**: `content.jovylle.com`'s D1-backed `/api/scores` API (`GET`/`POST`) for score writes/reads; legacy GitHub Contents API writes still used for other JSON files committed directly to this repo
- **Rate limiting**: Cloudflare KV (`SCORE_RATE_LIMIT` binding) backs a shared `checkRateLimit(env, { playerId, ip })` helper in `src/index.js` — 5s cooldown + 100/day cap per key (`playerId`, falls back to `cf-connecting-ip`). Fails open on KV errors so an infra hiccup never locks out real players.
- **Auth**: GitHub App JWT → installation access token (RS256) for legacy writes; `Authorization: Basic` (admin password) for `/api/scores` writes
- **Deploy**: Cloudflare Workers + Static Assets (`wrangler deploy`), auto-deploy on push to `master` via `.github/workflows/deploy.yml`
- **Content ecosystem**: `content.jovylle.com` — retrieve/store portfolio and project metadata, and now the score database for games (`/api/scores`)

## Data layer

```
reaction/
├── latest.json      # last score submitted
├── top.json         # top 10 leaderboard { top: [...], last_updated }
├── history.json     # full history { records: [...], total_records, last_updated, best_score }
└── history.ndjson   # append-only log (manual / future use)
```

Score object shape:
```json
{ "ms": 142, "timestamp": "ISO8601", "id": "hex8", "playerName": "str", "playerId": "fingerprint_str" }
```

## Environment variables / secrets (Cloudflare)

Secrets are set with `wrangler secret put <NAME>` (not committed). Plain vars can
live under `vars` in `wrangler.jsonc`.

```
CONTENT_ADMIN_PASSWORD   # secret — Basic auth password for content.jovylle.com's /api/scores writes
CONTENT_API_BASE         # optional var, defaults to https://content.jovylle.com
```

Legacy GitHub App vars (`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`,
`GITHUB_PRIVATE_KEY`) are only needed if a legacy GitHub-Contents write path is
reintroduced; the reaction flow does not use them.

`wrangler.jsonc` also binds a KV namespace:

```
kv_namespaces: [{ binding: "SCORE_RATE_LIMIT", id: "...", preview_id: "..." }]
```

used exclusively by the rate-limit helper in `src/index.js` — no other game data lives in KV.

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

The `POST /api/save-reaction-score` route in `src/index.js` is the original, standalone handler (kept unchanged for the reaction game's Best-of-5 + percentile logic). The 3 newer games (`number-memory`, `chimp-test`, `aim-trainer`) share a generic `handleSaveScore(request, env, config)` handler, parameterized per game by a `*_CONFIG` object (`game` name, `metricName`, `validateMetric`, `isNewRecord` comparator, `formatMessage`) — see `NUMBER_MEMORY_CONFIG`/`CHIMP_TEST_CONFIG`/`AIM_TRAINER_CONFIG` in `src/index.js`. Both paths do not write to this repo — they `POST` to `https://content.jovylle.com/api/scores` (Basic auth via `CONTENT_ADMIN_PASSWORD`), then `GET /api/scores?game=<name>&sort=top&limit=<N>` to compute `isNewRecord`/`position` (`sort=top` is assumed metric-agnostic — always "best first" for whichever game is queried, whether that means lowest `ms`/`avgMs` or highest `digits`/`gridSize`). Every route calls the shared `checkRateLimit`/`sanitizeField` helpers first. The frontend (`<game>/index.html`, `history.html`) reads directly from `/api/scores` as well.

## Adding a new game checklist

- [ ] `schemas/<game>.schema.json` (model on `schemas/reaction.schema.json`; state explicitly whether higher or lower is "better" for the metric — this drives the `isNewRecord` comparator)
- [ ] Add a `<game>_CONFIG` object and a routing check in `src/index.js` (reuse `handleSaveScore`, `checkRateLimit`, `sanitizeField` — don't duplicate them)
- [ ] `<game>/index.html` — single self-contained file, own inline styles, screen-toggle pattern (main/game/result), "← All games" link to `/`, link to `history.html?game=<name>`, share button on the result screen
- [ ] New card in the hub's `index.html` card grid
- [ ] Update `PROJECT_OVERVIEW.md`

Legacy per-game JSON files (`<game>/latest.json`, `top.json`, `history.json`) are **not** part of this pattern — the reaction game's copies are dead/unread by the Worker, and no new game needs them.
