# 🔧 GitHub App Setup Guide

This guide walks you through creating a GitHub App that can write to your playbase repository safely and securely.

## 📋 Prerequisites

- GitHub account with access to create apps
- Your playbase repository already created and public
- Basic understanding of environment variables

## 🚀 Step 1: Create the GitHub App

1. **Go to GitHub App creation page**
   ```
   https://github.com/settings/apps/new
   ```

2. **Fill in the basic information:**
   - **GitHub App name**: `playbase-bot` (or `your-username-playbase-bot`)
   - **Description**: `Automated bot for updating playbase JSON database`
   - **Homepage URL**: `https://github.com/your-username/playbase`
   - **Webhook URL**: Leave blank (we don't need webhooks)
   - **Webhook secret**: Leave blank

3. **Set Repository permissions:**
   - **Contents**: `Read and write` ✅
   - **Metadata**: `Read` ✅
   - **Pull requests**: `No access` (we don't need this)
   - **Issues**: `No access` (we don't need this)

4. **Set Account permissions:**
   - Leave all as `No access` (we only need repository access)

5. **Subscribe to events:**
   - **Uncheck all events** (we don't need webhook events)

6. **Where can this GitHub App be installed?**
   - Select **"Only on this account"** (more secure)

7. **Click "Create GitHub App"**

## 🔑 Step 2: Generate Private Key

1. **After creation, you'll be on your app's settings page**
2. **Scroll down to "Private keys" section**
3. **Click "Generate a private key"**
4. **A `.pem` file will download** - save this securely!
5. **Copy the App ID** from the top of the page (you'll need this)

## 📦 Step 3: Install the App

1. **On your app's settings page, click "Install App" in the left sidebar**
2. **Click "Install" next to your account**
3. **Choose "Only select repositories"**
4. **Select your `playbase` repository**
5. **Click "Install"**
6. **Copy the Installation ID** from the URL (it will look like `/settings/installations/12345678`)

## 🌐 Step 4: Set Environment Variables

You now have three pieces of information needed for your serverless function:

### For Netlify:

1. **Go to your Netlify site dashboard**
2. **Go to Site settings → Environment variables**
3. **Add these variables:**

```bash
GITHUB_APP_ID=123456
GITHUB_INSTALLATION_ID=12345678
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
-----END PRIVATE KEY-----"
```

### For Vercel:

1. **Go to your Vercel project dashboard**
2. **Go to Settings → Environment Variables**
3. **Add the same three variables as above**

### For Local Development:

Create a `.env` file in your project root:

```bash
# .env (never commit this file!)
GITHUB_APP_ID=123456
GITHUB_INSTALLATION_ID=12345678
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----"
```

**⚠️ Important Notes:**
- For environment variables, replace actual newlines in the private key with `\n`
- Never commit your `.env` file or private key to git
- The private key must include the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines

## 🧪 Step 5: Test Your Setup

Create a simple test script to verify everything works:

```javascript
// test-github-app.js
const jwt = require('jsonwebtoken');

async function testGitHubApp() {
  // Generate JWT
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    iss: process.env.GITHUB_APP_ID
  };

  const token = jwt.sign(payload, process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'), { 
    algorithm: 'RS256' 
  });

  console.log('✅ JWT generated successfully');

  // Test authentication
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

  if (authResponse.ok) {
    const { token: accessToken } = await authResponse.json();
    console.log('✅ Access token obtained successfully');
    
    // Test repository access
    const repoResponse = await fetch(
      'https://api.github.com/repos/your-username/playbase/contents/VERSION',
      {
        headers: {
          'Authorization': `token ${accessToken}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );

    if (repoResponse.ok) {
      console.log('✅ Repository access confirmed');
      console.log('🎉 GitHub App setup complete!');
    } else {
      console.error('❌ Repository access failed');
    }
  } else {
    console.error('❌ Authentication failed');
  }
}

testGitHubApp().catch(console.error);
```

Run the test:
```bash
npm install jsonwebtoken
node test-github-app.js
```

## 🔐 Security Best Practices

1. **Principle of Least Privilege**
   - Only give the minimum permissions needed (Contents: Read/Write, Metadata: Read)
   - Install only on repositories that need it

2. **Environment Variable Security**
   - Never commit private keys to git
   - Use your deployment platform's secure environment variable storage
   - Rotate private keys periodically

3. **Token Management**
   - GitHub App tokens automatically expire (1 hour)
   - Always generate fresh tokens for each API operation
   - Never store or cache access tokens

4. **Input Validation**
   - Always validate data before writing to GitHub
   - Use JSON schemas to ensure data integrity
   - Rate limit your API calls to avoid hitting GitHub's limits

## 🐛 Troubleshooting

### "Bad credentials" error
- Check that your App ID is correct (numeric, no quotes in env var)
- Verify your private key includes the BEGIN/END lines
- Make sure you're using the Installation ID, not the App ID

### "Not Found" error
- Verify the app is installed on the correct repository
- Check that the repository name and owner are correct in your code
- Ensure the repository is public or the app has access

### "Resource not accessible by integration" error
- Double-check your app permissions (Contents: Read & Write)
- Make sure you're using the installation access token, not the JWT

### Private key format issues
- The private key should be in PEM format
- For environment variables, replace newlines with `\n`
- Include the full key including BEGIN and END markers

## 📚 Additional Resources

- [GitHub Apps Documentation](https://docs.github.com/en/developers/apps/getting-started-with-apps)
- [GitHub REST API Reference](https://docs.github.com/en/rest)
- [JWT.io Debugger](https://jwt.io) - For debugging JWT tokens

---

**Next**: Deploy your serverless function and start saving game scores! 🎮