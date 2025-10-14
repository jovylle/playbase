const jwt = require('jsonwebtoken');

/**
 * Netlify Function: Save Reaction Test Score to GitHub JSON Database
 * 
 * This function demonstrates the full workflow:
 * 1. Validate incoming score data
 * 2. Generate GitHub App JWT token
 * 3. Exchange JWT for temporary access token
 * 4. Read existing JSON files from GitHub
 * 5. Update data structures
 * 6. Commit changes back to GitHub
 */

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // 1. Parse and validate the incoming score
    const { ms } = JSON.parse(event.body);
    
    if (!ms || typeof ms !== 'number' || ms < 80 || ms > 1000) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          error: 'Invalid reaction time. Must be between 80-1000ms.' 
        })
      };
    }

    // Generate unique ID and timestamp
    const timestamp = new Date().toISOString();
    const id = Math.random().toString(16).substr(2, 8);
    
    const newScore = { ms, timestamp, id };

    // 2. Generate GitHub App JWT
    const payload = {
      iat: Math.floor(Date.now() / 1000) - 60, // 1 minute ago (clock skew)
      exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes from now
      iss: process.env.GITHUB_APP_ID
    };

    const jwtToken = jwt.sign(payload, process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'), { 
      algorithm: 'RS256' 
    });

    // 3. Exchange JWT for installation access token
    const authResponse = await fetch(
      `https://api.github.com/app/installations/${process.env.GITHUB_INSTALLATION_ID}/access_tokens`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'playbase-bot/1.0'
        }
      }
    );

    if (!authResponse.ok) {
      console.error('GitHub auth failed:', await authResponse.text());
      throw new Error('GitHub authentication failed');
    }

    const { token: accessToken } = await authResponse.json();

    // 4. Read current JSON files from GitHub
    const owner = 'jovylle'; // Your GitHub username
    const repo = 'playbase';
    const branch = 'master';

    // Helper function to get file from GitHub
    const getGitHubFile = async (path) => {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
        {
          headers: {
            'Authorization': `token ${accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'playbase-bot/1.0'
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to fetch ${path}: ${response.status}`);
      }
      
      const data = await response.json();
      return {
        content: JSON.parse(Buffer.from(data.content, 'base64').toString()),
        sha: data.sha // Needed for updates
      };
    };

    // Helper function to update file on GitHub
    const updateGitHubFile = async (path, content, sha, message) => {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `token ${accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'playbase-bot/1.0',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message,
            content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
            sha,
            branch
          })
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to update ${path}: ${error}`);
      }

      return response.json();
    };

    // Get current files
    const [latestFile, topFile] = await Promise.all([
      getGitHubFile('reaction/latest.json'),
      getGitHubFile('reaction/top.json')
    ]);

    // 5. Update latest.json (always replace with new score)
    await updateGitHubFile(
      'reaction/latest.json',
      newScore,
      latestFile.sha,
      `feat(reaction): new ${ms}ms reaction time`
    );

    // 6. Update top.json if this score makes the top 10
    const currentTop = topFile.content.top || [];
    const updatedTop = [...currentTop, newScore]
      .sort((a, b) => a.ms - b.ms) // Sort by fastest time
      .slice(0, 10); // Keep only top 10

    const topData = {
      top: updatedTop,
      last_updated: timestamp
    };

    await updateGitHubFile(
      'reaction/top.json',
      topData,
      topFile.sha,
      `update(reaction): top scores updated with ${ms}ms`
    );

    // 7. Append to history.ndjson (optional - would need different approach)
    // For now, we'll skip this to keep the example simpler

    // 8. Return success response
    const isNewRecord = ms <= (currentTop[0]?.ms || Infinity);
    const position = updatedTop.findIndex(score => score.id === id) + 1;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' // Adjust for your domain
      },
      body: JSON.stringify({
        success: true,
        score: newScore,
        isNewRecord,
        position: position || null,
        message: isNewRecord ? 
          `🔥 NEW RECORD! ${ms}ms` : 
          position ? `Nice! Ranked #${position} with ${ms}ms` : `${ms}ms recorded`
      })
    };

  } catch (error) {
    console.error('Function error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to save score',
        details: error.message 
      })
    };
  }
};

/**
 * Environment Variables Required:
 * 
 * GITHUB_APP_ID - Your GitHub App ID (numeric)
 * GITHUB_INSTALLATION_ID - Installation ID after installing app to repo
 * GITHUB_PRIVATE_KEY - Private key from GitHub App (PEM format with \n escaped)
 * 
 * Example .env:
 * GITHUB_APP_ID=123456
 * GITHUB_INSTALLATION_ID=789012
 * GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC..."
 */

/**
 * Frontend Usage Example:
 * 
 * const submitScore = async (reactionTimeMs) => {
 *   const response = await fetch('/.netlify/functions/save-reaction-score', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ ms: reactionTimeMs })
 *   });
 *   
 *   const result = await response.json();
 *   console.log(result.message); // "🔥 NEW RECORD! 142ms"
 * };
 */