# Deployment Examples

## 🚀 Netlify Deployment

### Option 1: Git Integration (Recommended)

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "feat: initial playbase setup"
   git push origin main
   ```

2. **Connect to Netlify**
   - Go to [netlify.com](https://netlify.com)
   - Click "Add new site" → "Import an existing project"
   - Connect your GitHub account
   - Select your `playbase` repository
   - Build settings: (leave defaults for static site)
   - Click "Deploy site"

3. **Add Environment Variables**
   - Go to Site settings → Environment variables
   - Add your GitHub App credentials:
     ```
     GITHUB_APP_ID=123456
     GITHUB_INSTALLATION_ID=789012
     GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
     ```

### Option 2: Netlify CLI

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login to Netlify
netlify login

# Initialize in your project
netlify init

# Deploy
netlify deploy --prod
```

### Function Setup

Create `netlify/functions/save-reaction-score.js`:
```javascript
// Copy the content from examples/netlify-function.js
```

Your function will be available at:
```
https://your-site.netlify.app/.netlify/functions/save-reaction-score
```

## ▲ Vercel Deployment

### Option 1: Vercel CLI

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel

# Set environment variables
vercel env add GITHUB_APP_ID
vercel env add GITHUB_INSTALLATION_ID
vercel env add GITHUB_PRIVATE_KEY

# Redeploy with env vars
vercel --prod
```

### Option 2: Git Integration

1. **Push to GitHub** (same as Netlify)
2. **Import to Vercel**
   - Go to [vercel.com](https://vercel.com)
   - Click "Add New" → "Project"
   - Import your GitHub repository
3. **Add Environment Variables** in project settings

### API Routes Setup

Create `api/save-reaction-score.js`:
```javascript
// Copy the content from examples/netlify-function.js
// Remove the exports.handler wrapper and export as default
export default async function handler(req, res) {
  // Function logic here...
}
```

## 🧪 Testing Your Deployment

### Test the Function Endpoint

```bash
# Test with curl
curl -X POST https://your-site.netlify.app/.netlify/functions/save-reaction-score \
  -H "Content-Type: application/json" \
  -d '{"ms": 200}'

# Expected response:
# {"success":true,"score":{"ms":200,"timestamp":"...","id":"..."},"message":"Nice! Ranked #X with 200ms"}
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
        const response = await fetch('/.netlify/functions/save-reaction-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ms: Math.floor(Math.random() * 200) + 100 })
        });
        
        const result = await response.json();
        document.getElementById('result').innerHTML = JSON.stringify(result, null, 2);
    }
    </script>
</body>
</html>
```

## 📊 Verify Data Updates

After a successful submission, check your GitHub repository:

1. **Latest Score**: `https://raw.githubusercontent.com/your-username/playbase/main/reaction/latest.json`
2. **Top Scores**: `https://raw.githubusercontent.com/your-username/playbase/main/reaction/top.json`
3. **Commit History**: Check your repo's commit history for automatic updates

## 🐛 Common Issues

### CORS Errors
Add CORS headers to your function:
```javascript
return {
  statusCode: 200,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  },
  body: JSON.stringify(result)
};
```

### Environment Variable Issues
- Make sure variables are set in your deployment platform
- Check for extra quotes or spaces
- Verify the private key format (include BEGIN/END lines)

### GitHub API Rate Limits
- Primary rate limit: 5,000 requests per hour
- Secondary rate limit: ~12 requests per minute for writes
- Add retry logic with exponential backoff if needed

## 🔄 Continuous Deployment

Both Netlify and Vercel automatically redeploy when you push to your main branch. This means:

1. **Update your code** locally
2. **Push to GitHub**
3. **Automatic deployment** happens
4. **Test the new version**

Your playbase JSON database is now live and ready to accept game scores! 🎮