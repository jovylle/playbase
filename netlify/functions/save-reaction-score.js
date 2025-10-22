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
    const { ms, playerName, playerId } = JSON.parse(event.body);
    
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
    
    // Calculate current season
    const seasonStart = new Date('2025-01-15T00:00:00Z');
    const daysSinceStart = Math.floor((new Date() - seasonStart) / (1000 * 60 * 60 * 24));
    const currentSeason = Math.floor(daysSinceStart / 90) + 1; // 90 days (3 months) per season
    
    const newScore = { 
      ms, 
      timestamp, 
      id,
      playerName: playerName || 'Anonymous',
      playerId: playerId || 'unknown',
      season: currentSeason
    };

    // 2. Generate GitHub App JWT
    const payload = {
      iat: Math.floor(Date.now() / 1000) - 60, // 1 minute ago (clock skew)
      exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes from now
      iss: process.env.GITHUB_APP_ID
    };

    // Handle different private key formats
    let privateKey = process.env.GITHUB_PRIVATE_KEY;
    
    // If the key doesn't have proper line breaks, fix it
    if (privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }
    
    // Ensure proper formatting
    if (!privateKey.includes('\n')) {
      // If it's all on one line, reconstruct it properly
      privateKey = privateKey
        .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
        .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----')
        .replace(/(.{64})/g, '$1\n')  // Add newlines every 64 characters
        .replace(/\n\n/g, '\n')       // Remove double newlines
        .replace(/\n-----END/g, '\n-----END'); // Fix the end marker
    }

    console.log('Private key format check:', {
      hasBeginMarker: privateKey.includes('-----BEGIN PRIVATE KEY-----'),
      hasEndMarker: privateKey.includes('-----END PRIVATE KEY-----'),
      hasNewlines: privateKey.includes('\n'),
      length: privateKey.length
    });

    const jwtToken = jwt.sign(payload, privateKey, { 
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
      `feat(reaction): ${playerName || 'Anonymous'} scored ${ms}ms`
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
      `update(reaction): top scores updated with ${playerName || 'Anonymous'} ${ms}ms`
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