# 🧱 playbase

**A GitHub-based JSON database for public game data**

![Version](https://img.shields.io/badge/dynamic/raw?url=https://raw.githubusercontent.com/jovylle/playbase/main/VERSION&label=Version&query=.&color=blue)
![Fastest Reaction](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/jovylle/playbase/main/reaction/top.json&label=Fastest%20Reaction&query=$.top[0].ms&suffix=ms&color=brightgreen)

> **Turn GitHub into your free, versioned, public JSON database** 🚀

## 🎯 What is playbase?

Playbase is a **GitHub repository that acts as a public JSON database** for games and tools. Instead of setting up a traditional database, you store your data as JSON files in this repo and use GitHub's API to read/write them programmatically.

### ✨ Why use playbase?

- **Free forever** - GitHub is free for public repos
- **Globally accessible** - Raw GitHub URLs work anywhere
- **Versioned** - Full git history of all data changes
- **Dynamic badges** - Live stats displayed as shields.io badges
- **No backend needed** - Just serverless functions + GitHub API
- **Scalable** - Works for simple games to complex data sets

## 📂 Repository Structure

```
playbase/
├── reaction/                 # Reaction test game data
│   ├── latest.json          # Most recent score
│   ├── top.json             # Top 10 scores
│   └── history.ndjson       # Complete history (newline-delimited JSON)
├── schemas/                 # JSON schemas for validation
│   └── reaction.schema.json # Reaction score schema
├── examples/                # Example implementations
│   └── netlify-function.js  # Sample serverless function
├── VERSION                  # Current API version
└── README.md               # This file
```

## 🎮 Example: Reaction Test Game

The reaction test game measures how fast players can click after seeing a stimulus.

### Data Format

Each reaction score follows this schema:

```json
{
  "ms": 142,                           // Reaction time (80-1000ms)
  "timestamp": "2024-10-14T15:22:10.000Z", // ISO 8601 timestamp
  "id": "f9e8d7c6"                    // 8-char hex identifier
}
```

### Live Data URLs

- **Latest Score**: `https://raw.githubusercontent.com/jovylle/playbase/main/reaction/latest.json`
- **Top 10**: `https://raw.githubusercontent.com/jovylle/playbase/main/reaction/top.json`  
- **Full History**: `https://raw.githubusercontent.com/jovylle/playbase/main/reaction/history.ndjson`

### Dynamic Badges

```markdown
![Fastest Reaction](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/jovylle/playbase/main/reaction/top.json&label=Fastest&query=$.top[0].ms&suffix=ms&color=brightgreen)
```

![Fastest Reaction](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/jovylle/playbase/main/reaction/top.json&label=Fastest&query=$.top[0].ms&suffix=ms&color=brightgreen)

## 🔧 How to Write Data

### 1. GitHub App Setup

Create a GitHub App with these permissions:
- **Repository → Contents**: Read & Write
- **Repository → Metadata**: Read-only

### 2. Environment Variables

```bash
GITHUB_APP_ID=123456
GITHUB_INSTALLATION_ID=789012
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

### 3. Serverless Function Example

```javascript
// Netlify Function example
const jwt = require('jsonwebtoken');

exports.handler = async (event) => {
  // 1. Validate incoming score
  const { ms } = JSON.parse(event.body);
  if (ms < 80 || ms > 1000) {
    return { statusCode: 400, body: 'Invalid score' };
  }

  // 2. Generate GitHub App JWT
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    iss: process.env.GITHUB_APP_ID
  };
  const token = jwt.sign(payload, process.env.GITHUB_PRIVATE_KEY, { algorithm: 'RS256' });

  // 3. Get installation access token
  const authResponse = await fetch(
    `https://api.github.com/app/installations/${process.env.GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    }
  );
  const { token: accessToken } = await authResponse.json();

  // 4. Update JSON files via GitHub API
  // ... implementation details ...
  
  return { statusCode: 200, body: 'Score saved!' };
};
```

## 🎲 Future Games

Playbase can expand to support any game data:

- **Click Speed** → `click/records.json`
- **Color Memory** → `color/leaderboard.json`  
- **Typing Test** → `typing/stats.json`
- **Math Quiz** → `math/highscores.json`

Each game gets its own folder with standardized JSON files.

## 📊 Data Patterns

### Common File Types

- `latest.json` - Most recent entry
- `top.json` - Best scores/records
- `history.ndjson` - Complete chronological history
- `stats.json` - Aggregated statistics

### Badge Examples

```markdown
![Top Score](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/jovylle/playbase/main/game/top.json&label=Record&query=$.best.score&color=gold)

![Total Players](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/jovylle/playbase/main/game/stats.json&label=Players&query=$.total_players&color=blue)

![Games Played](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/jovylle/playbase/main/game/stats.json&label=Games&query=$.total_games&suffix=%20played&color=green)
```

## 🔒 Security Notes

- GitHub App tokens expire automatically (1 hour)
- Only your serverless functions can write data
- All data is public (by design)
- Input validation prevents malicious data
- Rate limiting handled by GitHub API

## 🚀 Getting Started

1. **Fork this repo** or use as template
2. **Set up GitHub App** (see examples folder for guide)
3. **Deploy serverless function** with environment variables
4. **Add badges** to your game's README
5. **Start saving scores!**

---

**Made with ❤️ for the indie game dev community**

[🎮 Play Reaction Test](https://your-game-url.com) | [📊 View Live Data](https://raw.githubusercontent.com/jovylle/playbase/main/reaction/top.json) | [⚙️ GitHub App Setup](./examples/github-app-setup.md)