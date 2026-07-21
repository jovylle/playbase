# Playbase — Claude Code Instructions

## What this project is

Mini-game platform. Players play browser games; scores are written via Netlify serverless functions to a D1-backed `/api/scores` resource on `content.jovylle.com`. Some legacy game data still lives as JSON files committed to this repo via the GitHub App API, but new writes for reaction scores go through the content API, not GitHub Contents.

Live URL: **https://fast.jovylle.com**

## Stack

- **Frontend**: Vanilla HTML/CSS/JS, single-file per game (`index.html`, `history.html`)
- **Backend**: Netlify Functions (`netlify/functions/*.js`)
- **Database**: `content.jovylle.com`'s D1-backed `/api/scores` API (`GET`/`POST`) for score writes/reads; legacy GitHub Contents API writes still used for other JSON files committed directly to this repo
- **Auth**: GitHub App JWT → installation access token (RS256) for legacy writes; `Authorization: Basic` (admin password) for `/api/scores` writes
- **Deploy**: Netlify (static + functions), auto-deploy on push to `master`
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

## Environment variables (Netlify)

```
GITHUB_APP_ID
GITHUB_INSTALLATION_ID
GITHUB_PRIVATE_KEY   # PEM with \n escaped
CONTENT_ADMIN_PASSWORD   # Basic auth password for content.jovylle.com's /api/scores writes
CONTENT_API_BASE         # optional, defaults to https://content.jovylle.com
```

## Key conventions

- **New game = new folder** under the repo root (e.g. `memory/`, `typing/`) with its own JSON data files and a matching Netlify function in `netlify/functions/save-<game>-score.js`.
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

## Reaction score write pattern

`netlify/functions/save-reaction-score.js` no longer writes to this repo. It
`POST`s to `https://content.jovylle.com/api/scores` (Basic auth via
`CONTENT_ADMIN_PASSWORD`), then `GET`s `/api/scores?game=reaction&sort=top&limit=10`
to compute `isNewRecord`/`position`. The frontend (`index.html`, `history.html`)
reads directly from `/api/scores` as well.

## Adding a new game checklist

- [ ] `<game>/latest.json`, `<game>/top.json`, `<game>/history.json` (initial empty state)
- [ ] `schemas/<game>.schema.json`
- [ ] `netlify/functions/save-<game>-score.js` (copy reaction function, adapt validation + schema)
- [ ] New HTML page or section in `index.html`
- [ ] Update `PROJECT_OVERVIEW.md`
