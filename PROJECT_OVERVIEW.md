# 🎮 Playbase - Mini-Game Hub

## 🎯 Project Goal

**Playbase** is a mini-game platform: a lightweight hub linking to 4 browser mini-games, each with a public, real-time leaderboard backed by a Cloudflare D1 database (`cms-db`, shared with `content.jovylle.com`) bound *directly* into the Playbase Worker, and served as vanilla-JS Cloudflare static assets.

## 🏗️ Core Concept

- **Hub + per-game folders** — root `index.html` is a card-grid hub; each game lives in its own folder as a single self-contained HTML file (no shared design system across pages, by design)
- **Direct D1 binding** as the score database for all games — the Worker binds `cms-db` (the same physical database `content.jovylle.com` uses) as `env.DB` and reads/writes the `scores` table itself, with no HTTP round-trip through `content.jovylle.com` (GitHub-Contents-as-database is legacy, kept only for a few unread JSON files)
- **Cloudflare Worker** (`src/index.js`) as the only backend surface, handling `/api/save-<game>-score` writes, `GET /api/scores` reads, and leaderboard queries — all directly against D1
- **Cloudflare KV** for lightweight, game-agnostic rate-limiting shared across every game's score-submission route

## 🔥 Current Implementation: 4 Games

| Game | Folder | Metric | Direction |
|---|---|---|---|
| Reaction Tester | `reaction/` | `ms` (Best-of-5 average) | lower is better |
| Number Memory | `number-memory/` | `digits` | higher is better |
| Chimp Test | `chimp-test/` | `gridSize` | higher is better |
| Aim Trainer | `aim-trainer/` | `avgMs` | lower is better |

Reaction Tester additionally shows a percentile stat ("Faster than X% of players") and all 4 games have a Share button (copies a short result summary to the clipboard). `history.html?game=<name>` shows any game's leaderboard/history (defaults to `reaction`).

## 📊 Database Schema

### D1 `scores` table (shared `cms-db`, bound as `env.DB`)

```sql
CREATE TABLE scores (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  ms INTEGER NOT NULL CHECK (ms > 0),   -- generic metric column, see below
  player_name TEXT NOT NULL,
  player_id TEXT NOT NULL,
  created_at TEXT NOT NULL              -- ISO8601
)
```

One table serves all 4 games; `game` discriminates rows, and the single `ms`
column is reused as the generic metric column no matter what that game
actually calls its metric (reaction `ms`, number-memory `digits`, chimp-test
`gridSize`, aim-trainer `avgMs` are all stored as `ms`). On read, `shapeScore(game, row)`
in `src/index.js` echoes the raw `ms` value back out under each game's
frontend-expected alias field(s) — see the table below.

| game | stored in `ms` as | aliased back to |
|---|---|---|
| `reaction` | reaction time (ms) | `ms` (no alias needed) |
| `number-memory` | digit count | `digits` |
| `chimp-test` | grid size | `gridSize` **and** `grid_size` (two different consumers expect two different cases) |
| `aim-trainer` | avg click time (ms) | `avgMs` |

### Legacy JSON files (dead, unread by the Worker)
```
reaction/
├── latest.json     # Most recent score — legacy, dead
├── top.json        # Top 10 leaderboard — legacy, dead
└── history.ndjson  # Full history log — legacy, dead
```

### Data Models

**Save-response score object** (unchanged shape from before the D1 migration):
```json
{
  "ms": 142,
  "timestamp": "2025-10-21T10:30:00.000Z",
  "id": "a1b2c3d4",
  "playerName": "FlashPro5",
  "playerId": "fp_1920x1080_chrome"
}
```

**`GET /api/scores` row shape** (`{ scores: [...] }`, snake_case, straight from D1):
```json
{
  "id": "a1b2c3d4",
  "game": "reaction",
  "ms": 142,
  "player_name": "FlashPro5",
  "player_id": "fp_1920x1080_chrome",
  "created_at": "2025-10-21T10:30:00.000Z"
}
```

## 🏛️ Architecture

### Frontend (`index.html` hub + `<game>/index.html`)
- **Vanilla HTML/CSS/JS** for instant loading, one self-contained file per game
- **Hub card grid** at root linking to each game and to `history.html`
- **Browser fingerprinting** for unique player IDs
- **localStorage** for player name persistence
- **Responsive design** optimized for mobile and desktop (44px+ tap targets, `touch-action: manipulation`)

### Backend (`src/index.js` — Cloudflare Worker)
- **`POST /api/save-reaction-score`** — standalone handler (Best-of-5 averaging + percentile stat are reaction-specific)
- **`POST /api/save-<game>-score`** (number-memory, chimp-test, aim-trainer) — share a generic `handleSaveScore(request, env, config)` handler parameterized by a per-game config object
- **`GET /api/scores`** — public, CORS-open read endpoint (`handleGetScores`), served directly from D1, usable by other tools independent of content.jovylle.com
- **D1-direct persistence** — `insertScore`/`queryScores` helpers query `env.DB` (the `cms-db` binding) directly; no HTTP call, no auth header, no upstream dependency for score reads/writes
- **Leaderboard ordering** driven by a `BETTER_DIRECTION` (`'asc'`/`'desc'`) fact per game config, resolved via `directionForGame` and applied as a fixed literal `ORDER BY` clause (never string-interpolated from user input)
- **Rate limiting**: shared `checkRateLimit(env, { playerId, ip })` helper backed by the `SCORE_RATE_LIMIT` KV namespace — 5s cooldown + 100/day cap per key, fails open on KV errors
- **Input hardening**: `sanitizeField` strips control chars and caps length on `playerName`/`playerId`; 500 responses no longer leak internal error details to clients

### Authentication System
- **None required for score reads/writes** — the Worker inserts/queries the bound D1 database directly, so there's no per-request credential in the score-save path anymore. `CONTENT_ADMIN_PASSWORD`/`CONTENT_API_BASE` are no longer used by these routes (the Cloudflare secret is left in place, just unused).
- **GitHub App** (JWT, RS256, PKCS#8 key) still used for legacy games writing directly to this repo's Contents API

## 🚀 Key Features

### ✨ Performance Optimizations
- **Sub-second loading** with inline CSS/JS
- **No external dependencies** for core functionality
- **Optimized viewport** with no scrolling
- **Touch-optimized** controls for mobile

### 🎯 Player Identity System
- **Unique player IDs** via browser fingerprinting
- **Customizable player names** with localStorage persistence
- **Anonymous by default** with optional personalization
- **Cross-session persistence** without accounts

### 🏆 Real-time Leaderboard
- **Live updates** straight from D1 via `GET /api/scores`
- **Top 5/10 display** on each game's interface
- **Automatic ranking** with instant feedback (`isNewRecord`/`position` computed on save)
- **Public read access** — any tool can query `GET /api/scores` directly, independent of content.jovylle.com

### 🔒 Security & Reliability
- **Per-game metric range validation** (e.g. reaction 80-1000ms) on frontend and backend
- **Rate limiting** via KV — 5s cooldown + 100/day cap per player, fails open on infra errors
- **Input sanitization** — control-char stripping and length caps on player-supplied name/id
- **Error handling** with graceful degradation; internal error details are never leaked in API responses

## 📁 File Structure

```
playbase/
├── index.html                           # Hub: card grid linking to all 4 games + history
├── history.html                         # Shared history/leaderboard page (?game=<name>)
├── reaction/index.html                  # Reaction Tester (Best-of-5, percentile, share)
├── number-memory/index.html             # Number Memory
├── chimp-test/index.html                # Chimp Test
├── aim-trainer/index.html                # Aim Trainer
├── schemas/
│   ├── reaction.schema.json
│   ├── number-memory.schema.json
│   ├── chimp-test.schema.json
│   └── aim-trainer.schema.json
├── src/
│   └── index.js                         # Cloudflare Worker (/api/* routes, rate limiting)
├── wrangler.jsonc                       # Cloudflare Workers + Static Assets config, KV binding
├── .assetsignore                        # Files excluded from static-asset upload
├── .github/workflows/deploy.yml         # wrangler deploy on push to master
├── .graph/discovery-log.yaml            # /discover run history
├── PROJECT_OVERVIEW.md                  # This documentation
└── README.md                            # Basic project info
```

## 🔧 Environment Setup

### D1 binding (`wrangler.jsonc`)
```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "cms-db", "database_id": "8ba72fee-60b8-47b6-b4a8-db28722ead1a" }
]
```
No secret or API token is required for score reads/writes — the binding grants
direct D1 access at deploy time.

### Legacy secrets (no longer used by score routes, kept for other purposes)
```bash
CONTENT_ADMIN_PASSWORD=...            # secret — unused by score routes now
CONTENT_API_BASE=https://content.jovylle.com   # optional var — unused by score routes now
```
In CI, `.github/workflows/deploy.yml` needs a `CLOUDFLARE_API_TOKEN` (and, for
multi-account tokens, `CLOUDFLARE_ACCOUNT_ID`) repo secret for `wrangler deploy`
to authenticate.

## 🌐 Deployment

- **Hosting**: Cloudflare Workers + Static Assets
- **Backend**: Cloudflare Worker (`src/index.js`, `/api/*` routes)
- **Score database**: Cloudflare D1, `cms-db`, bound directly as `env.DB` — no HTTP hop through content.jovylle.com
- **Deploy**: `wrangler deploy`, automated on push to `master`
- **Domain**: https://fast.jovylle.com

## 🧪 Sample Usage

### Save a score
```bash
curl -X POST https://fast.jovylle.com/api/save-reaction-score \
  -H 'Content-Type: application/json' \
  -d '{"ms": 187, "playerName": "FlashPro5", "playerId": "fp_1920x1080_chrome"}'
```
```json
{
  "success": true,
  "score": { "ms": 187, "timestamp": "2026-07-23T09:12:00.000Z", "id": "a1b2c3d4", "playerName": "FlashPro5", "playerId": "fp_1920x1080_chrome" },
  "isNewRecord": false,
  "position": 4,
  "percentile": 92,
  "message": "Nice! Ranked #4 with 187ms"
}
```

Other games use the same shape with a different metric field and route:
```bash
curl -X POST https://fast.jovylle.com/api/save-number-memory-score \
  -H 'Content-Type: application/json' \
  -d '{"digits": 11, "playerName": "MemoryMax", "playerId": "fp_1920x1080_chrome"}'

curl -X POST https://fast.jovylle.com/api/save-chimp-test-score \
  -H 'Content-Type: application/json' \
  -d '{"gridSize": 14, "playerName": "ChimpChamp", "playerId": "fp_1920x1080_chrome"}'

curl -X POST https://fast.jovylle.com/api/save-aim-trainer-score \
  -H 'Content-Type: application/json' \
  -d '{"avgMs": 412, "playerName": "Sharpshooter", "playerId": "fp_1920x1080_chrome"}'
```

### Read the leaderboard / history
`GET /api/scores?game=<name>&sort=top|recent&limit=<n>` is public (CORS-open)
and independent of content.jovylle.com — any tool can call it directly.

```bash
# Top 10 fastest reaction times
curl 'https://fast.jovylle.com/api/scores?game=reaction&sort=top&limit=10'

# Most recent 200 chimp-test submissions (for history.html-style views)
curl 'https://fast.jovylle.com/api/scores?game=chimp-test&sort=recent&limit=200'
```
```json
{
  "scores": [
    { "id": "a1b2c3d4", "game": "reaction", "ms": 142, "player_name": "FlashPro5", "player_id": "fp_1920x1080_chrome", "created_at": "2025-10-21T10:30:00.000Z" }
  ]
}
```

- `game` — one of `reaction`, `number-memory`, `chimp-test`, `aim-trainer` (400 if missing/unknown)
- `sort` — `top` (best-first per that game's direction) or `recent` (newest-first); defaults to `top` (400 if invalid)
- `limit` — defaults to 10, clamped to `[1, 1000]`
- `chimp-test` rows include **both** `gridSize` and `grid_size` in the `GET /api/scores` response (two different existing consumers read two different cases for the same value) — everything else has a single alias, see the Database Schema table above.

## 🎮 Game Flow

1. **Landing Page**: Clean interface with play button
2. **Game Start**: Instructions and countdown
3. **Waiting Phase**: Gray screen, random 1-5 second delay
4. **Action Phase**: Screen turns red, player clicks
5. **Result Phase**: Show reaction time and leaderboard position
6. **Data Persistence**: Score automatically saved to GitHub
7. **Leaderboard Update**: Real-time ranking updates

## 🔮 Future Expansions

### Additional Games
- **Typing speed** tests
- **Math problems** (speed calculation)
- **Color matching** games

### Enhanced Features
- **Game categories** with separate leaderboards
- **Daily/weekly** challenges
- **Achievement system** with badges
- **Player profiles** with game history
- **Social features** (friends, sharing)

### Technical Improvements
- **GraphQL API** for complex queries
- **Real-time updates** with WebSockets
- **Advanced analytics** with game metrics
- **A/B testing** framework
- **Performance monitoring** with detailed metrics

## 🎯 Why GitHub as Database? (historical — superseded by D1)

> This section documents the project's original design rationale. Score
> storage has since moved to Cloudflare D1 (see Database Schema above);
> GitHub-Contents-as-database is legacy and only a few unread JSON files
> still use it.

### Advantages
- ✅ **Free hosting** for public data
- ✅ **Built-in version control** for data history
- ✅ **Transparent operations** with public commits
- ✅ **Excellent API** with robust authentication
- ✅ **High availability** with GitHub's infrastructure
- ✅ **Easy backup** with git cloning
- ✅ **Collaborative features** with pull requests

### Use Cases
- 🎮 **Game leaderboards** (current implementation)
- 📊 **Public datasets** with collaborative editing
- 🏆 **Competition results** with transparent judging
- 📈 **Real-time dashboards** with version history
- 🌍 **Crowdsourced data** collection
- 📝 **Public APIs** with JSON file serving

## 🔍 Technical Deep Dive

### GitHub API Integration
```javascript
// JWT Generation
const payload = {
  iat: Math.floor(Date.now() / 1000) - 60,
  exp: Math.floor(Date.now() / 1000) + 600,
  iss: process.env.GITHUB_APP_ID
};
const jwtToken = jwt.sign(payload, privateKey, { algorithm: 'RS256' });

// File Update
const response = await fetch(
  `https://api.github.com/repos/jovylle/playbase/contents/reaction/top.json`,
  {
    method: 'PUT',
    headers: { 'Authorization': `token ${accessToken}` },
    body: JSON.stringify({
      message: `update(reaction): ${playerName} scored ${ms}ms`,
      content: Buffer.from(JSON.stringify(newData)).toString('base64'),
      sha: currentSha,
      branch: 'master'
    })
  }
);
```

### Player Identity System
```javascript
// Browser Fingerprinting
function generatePlayerId() {
  const screen = `${window.screen.width}x${window.screen.height}`;
  const platform = navigator.platform || 'unknown';
  const userAgent = navigator.userAgent.split(' ').slice(-2).join('_');
  return `${screen}_${platform}_${userAgent}`.replace(/[^a-zA-Z0-9_]/g, '');
}

// localStorage Persistence
const savedName = localStorage.getItem('playbase_player_name');
const playerName = savedName || generateDefaultName();
```

## 📚 Learning Outcomes

This project demonstrates:
- **Alternative database** solutions for simple use cases
- **Serverless architecture** with Cloudflare Workers + Static Assets
- **GitHub API** advanced usage patterns
- **JWT authentication** implementation
- **Real-time data** updates without WebSockets
- **Performance optimization** for instant loading
- **Mobile-first** responsive design
- **Progressive enhancement** principles

## 🤝 Contributing

The project is designed to be:
- **Beginner-friendly** with clear code structure
- **Well-documented** with inline comments
- **Easily extensible** for new games
- **Open source** for learning and collaboration

## 📈 Success Metrics

- ⚡ **Loading speed**: Sub-second initial load
- 🎯 **Accuracy**: Precise reaction time measurement
- 🔄 **Reliability**: 99%+ successful score submissions
- 📱 **Compatibility**: Works on all modern browsers
- 🏆 **Engagement**: Real-time leaderboard updates

---

**Built with ❤️ as a demonstration of GitHub's potential as a simple, transparent database solution for public data.**