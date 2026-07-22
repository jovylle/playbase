# Deployment Guide

> This project used to deploy to Netlify Functions; it now deploys to
> Cloudflare Workers + Static Assets via `wrangler`. This guide reflects the
> current setup.

## 🚀 Cloudflare Workers Deployment

### Option 1: GitHub Actions Auto-Deploy (Recommended)

Every push to `master` triggers `.github/workflows/deploy.yml`, which runs
`wrangler deploy` for you. This requires two repo secrets:

- `CLOUDFLARE_API_TOKEN` — a token with Workers Scripts edit permission
- `CLOUDFLARE_ACCOUNT_ID` — only strictly required if the token has access to
  more than one account, but safe to set either way

Set them under **Settings → Secrets and variables → Actions** in GitHub. Once
set, just `git push origin master` and the deploy happens automatically.

### Option 2: Manual Deploy with Wrangler CLI

```bash
# Install dependencies (installs wrangler as a devDependency)
npm install

# Authenticate wrangler with your Cloudflare account (one-time)
npx wrangler login

# Local dev server (runs the Worker + serves static assets)
npm run dev   # wrangler dev

# Deploy
npm run deploy   # wrangler deploy
```

### Set the Required Secret

The `/api/save-reaction-score` route authenticates to `content.jovylle.com`
with Basic auth. Set the password as a Worker secret (never commit it):

```bash
wrangler secret put CONTENT_ADMIN_PASSWORD
```

`CONTENT_API_BASE` is an optional plain var (defaults to
`https://content.jovylle.com`) and can live under `vars` in `wrangler.jsonc`
if you ever need to override it.

### Worker + Assets Layout

- `wrangler.jsonc` — configures `assets.directory: "."` (serves the repo root
  as static assets) and `run_worker_first: ["/api/*"]` so `/api/*` requests
  hit the Worker instead of the static asset handler.
- `.assetsignore` — excludes source/config/docs from being served as static
  files, while keeping `index.html`, `history.html`, `image.png`, and
  `reaction/*.json` servable.
- `src/index.js` — the Worker's `fetch` handler. `POST /api/save-reaction-score`
  is handled directly; everything else falls through to `env.ASSETS.fetch`.

## 🧪 Testing Your Deployment

### Test the API Endpoint

```bash
# Test with curl
curl -X POST https://fast.jovylle.com/api/save-reaction-score \
  -H "Content-Type: application/json" \
  -d '{"ms": 200, "playerName": "test", "playerId": "fingerprint_abc"}'

# Expected response:
# {"success":true,"score":{"ms":200,"timestamp":"...","id":"...","playerName":"test","playerId":"fingerprint_abc"},"isNewRecord":false,"position":X,"message":"..."}
```

### Test Locally First

```bash
npm run dev
# then, in another terminal:
curl -X POST http://localhost:8787/api/save-reaction-score \
  -H "Content-Type: application/json" \
  -d '{"ms": 200, "playerName": "test", "playerId": "fingerprint_abc"}'
```

### Test with JavaScript

```html
<!DOCTYPE html>
<html>
<head>
    <title>Test Playbase</title>
</head>
<body>
    <button onclick="testSubmit()">Test Submit Score</button>
    <div id="result"></div>

    <script>
    async function testSubmit() {
        const response = await fetch('/api/save-reaction-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ms: Math.floor(Math.random() * 200) + 100,
                playerName: 'test',
                playerId: 'fingerprint_abc'
            })
        });

        const result = await response.json();
        document.getElementById('result').innerHTML = JSON.stringify(result, null, 2);
    }
    </script>
</body>
</html>
```

## 📊 Verify Data Updates

After a successful submission, check the scores API directly:

```bash
curl "https://content.jovylle.com/api/scores?game=reaction&sort=top&limit=10"
```

Legacy game data that still uses the GitHub-Contents pattern (see
`examples/github-app-setup.md`) can still be checked via commit history and
raw GitHub URLs, e.g. `https://raw.githubusercontent.com/jovylle/playbase/main/<game>/latest.json`.

## 🐛 Common Issues

### CORS Errors
Make sure `src/index.js` sets CORS headers on the API response:
```javascript
return new Response(JSON.stringify(result), {
  status: 200,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  }
});
```

### Secret / Env Variable Issues
- Confirm the secret is set: `wrangler secret list` (shows names only, not values)
- Re-run `wrangler secret put CONTENT_ADMIN_PASSWORD` if it's missing or wrong
- Plain vars (like `CONTENT_API_BASE`) live in `wrangler.jsonc` under `vars`, not as secrets

### Deploy Failures in GitHub Actions
- Verify `CLOUDFLARE_API_TOKEN` has Workers Scripts edit permission
- Verify `CLOUDFLARE_ACCOUNT_ID` matches the account the token belongs to
- Check the Actions log for the exact `wrangler deploy` error

## 🔄 Continuous Deployment

Every push to `master` runs `.github/workflows/deploy.yml`, which:

1. Checks out the repo
2. Installs dependencies (`npm ci`)
3. Runs `wrangler deploy` via `cloudflare/wrangler-action@v3`

No manual step is needed after merging to `master` — the Worker and its
static assets redeploy automatically.
