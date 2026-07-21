# 🎮 Playbase - GitHub JSON Database Game Platform

## 🎯 Project Goal

**Playbase** is a proof-of-concept for using **GitHub as a JSON database** for storing game scores publicly. It demonstrates how to build a real-time game leaderboard system using GitHub's API as the backend, Netlify serverless functions as middleware, and a lightning-fast vanilla JavaScript frontend.

## 🏗️ Core Concept

Instead of traditional databases (PostgreSQL, MongoDB, etc.), this project uses:
- **GitHub repository** as the database storage
- **JSON files** as data tables
- **GitHub App** for authenticated API access
- **Serverless functions** as the API layer
- **Public repository** for transparent, open data

## 🔥 Current Implementation: Reaction Tester

The first game implemented is a **reaction speed tester** where players:
1. Wait for a screen to turn red
2. Click as fast as possible
3. Get their reaction time in milliseconds
4. Compete on a public leaderboard

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

### Frontend (`index.html`)
- **Vanilla HTML/CSS/JS** for instant loading
- **Progressive asset loading** for optimal performance
- **Browser fingerprinting** for unique player IDs
- **localStorage** for player name persistence
- **Responsive design** optimized for mobile and desktop

### Backend (`netlify/functions/save-reaction-score.js`)
- **Netlify serverless function** handles score submissions
- **Basic auth** (`CONTENT_ADMIN_PASSWORD`) against content.jovylle.com's D1-backed API
- **`POST`/`GET /api/scores`** on content.jovylle.com for score writes/reads (reaction game)
- **Top 10 leaderboard** maintenance via `sort=top` query, computed live from the API

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
- **Rate limiting** (80-1000ms valid range)
- **Input validation** on frontend and backend
- **Error handling** with graceful degradation
- **Retry logic** for network failures

## 📁 File Structure

```
playbase/
├── index.html                           # Main game interface
├── netlify/
│   └── functions/
│       └── save-reaction-score.js       # Score submission API
├── reaction/
│   ├── latest.json                      # Latest score
│   └── top.json                         # Top 10 leaderboard
├── .env                                 # GitHub App credentials
├── netlify.toml                         # Netlify configuration
├── PROJECT_OVERVIEW.md                  # This documentation
└── README.md                            # Basic project info
```

## 🔧 Environment Setup

### Required Environment Variables
```bash
GITHUB_APP_ID=123456
GITHUB_INSTALLATION_ID=789012
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
```

### GitHub App Permissions
- **Contents: Read and Write** (for JSON file updates)
- **Metadata: Read** (for repository access)

## 🌐 Deployment

- **Frontend**: Netlify static hosting
- **Backend**: Netlify Functions (serverless)
- **Database**: GitHub repository (jovylle/playbase)
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
- **Memory tests** (sequence recall)
- **Typing speed** tests
- **Math problems** (speed calculation)
- **Color matching** games
- **Pattern recognition** challenges

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
- **Serverless architecture** with Netlify Functions
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