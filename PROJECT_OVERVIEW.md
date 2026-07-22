# 🎮 Playbase - Mini-Game Hub

## 🎯 Project Goal

**Playbase** is a mini-game platform: a lightweight hub linking to 4 browser mini-games, each with a public, real-time leaderboard backed by `content.jovylle.com`'s D1-backed `/api/scores` API, fronted by a Cloudflare Worker, and served as vanilla-JS Cloudflare static assets.

## 🏗️ Core Concept

- **Hub + per-game folders** — root `index.html` is a card-grid hub; each game lives in its own folder as a single self-contained HTML file (no shared design system across pages, by design)
- **`content.jovylle.com` D1 API** as the score database for all games (current architecture — GitHub-Contents-as-database is legacy, kept only for a few unread JSON files)
- **Cloudflare Worker** (`src/index.js`) as the only backend surface, handling `/api/save-<game>-score` writes and read-through leaderboard queries
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

### JSON Files Structure
```
reaction/
├── latest.json     # Most recent score
├── top.json        # Top 10 leaderboard
└── history.ndjson  # Full history log (planned)
```

### Data Models

**Score Object:**
```json
{
  "ms": 142,
  "timestamp": "2025-10-21T10:30:00.000Z",
  "id": "a1b2c3d4",
  "playerName": "FlashPro5",
  "playerId": "fp_1920x1080_chrome"
}
```

**Top Scores (top.json):**
```json
{
  "top": [
    { "ms": 142, "timestamp": "...", "id": "...", "playerName": "FlashPro5", "playerId": "..." },
    { "ms": 156, "timestamp": "...", "id": "...", "playerName": "SpeedDemon", "playerId": "..." }
  ],
  "last_updated": "2025-10-21T10:30:00.000Z"
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
- **Basic auth** (`CONTENT_ADMIN_PASSWORD`) against content.jovylle.com's D1-backed API
- **`POST`/`GET /api/scores`** on content.jovylle.com for score writes/reads, one `game` value per game
- **Leaderboard** maintenance via `sort=top` query (assumed metric-agnostic — best-first for whichever game), computed live from the API
- **Rate limiting**: shared `checkRateLimit(env, { playerId, ip })` helper backed by the `SCORE_RATE_LIMIT` KV namespace — 5s cooldown + 100/day cap per key, fails open on KV errors
- **Input hardening**: `sanitizeField` strips control chars and caps length on `playerName`/`playerId`; 500 responses no longer leak internal error details to clients

### Authentication System
- **Basic auth** (`admin:${CONTENT_ADMIN_PASSWORD}`, base64-encoded) for score writes to content.jovylle.com
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
- **Live updates** via GitHub API
- **Top 5 display** on game interface
- **Automatic ranking** with instant feedback
- **Public transparency** via GitHub repository

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

### Required Secrets / Variables (Cloudflare)
Set the secret with `wrangler secret put CONTENT_ADMIN_PASSWORD`; `CONTENT_API_BASE`
is an optional plain var (defaults to `https://content.jovylle.com`).
```bash
CONTENT_ADMIN_PASSWORD=...            # secret (wrangler secret put)
CONTENT_API_BASE=https://content.jovylle.com   # optional var
```
In CI, `.github/workflows/deploy.yml` needs a `CLOUDFLARE_API_TOKEN` (and, for
multi-account tokens, `CLOUDFLARE_ACCOUNT_ID`) repo secret.

## 🌐 Deployment

- **Hosting**: Cloudflare Workers + Static Assets
- **Backend**: Cloudflare Worker (`src/index.js`, `/api/*` routes)
- **Score database**: content.jovylle.com `/api/scores` (D1-backed)
- **Deploy**: `wrangler deploy`, automated on push to `master`
- **Domain**: https://fast.jovylle.com

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

## 🎯 Why GitHub as Database?

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