/**
 * Netlify Function: Season Reset
 * 
 * Manually triggers a season reset (for testing or admin use)
 * Usage: POST /.netlify/functions/season-reset
 */

const { Octokit } = require('@octokit/rest');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Get GitHub App credentials
    const appId = process.env.GITHUB_APP_ID;
    const installationId = process.env.GITHUB_INSTALLATION_ID;
    const privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!appId || !installationId || !privateKey) {
      throw new Error('Missing GitHub App credentials');
    }

    // Initialize GitHub client
    const octokit = new Octokit({
      auth: `Bearer ${await getGitHubToken(appId, installationId, privateKey)}`
    });

    const owner = 'jovylle';
    const repo = 'playbase';
    const branch = 'master';

    // Get current season info
    const currentDate = new Date();
    const seasonStart = new Date('2025-01-15T00:00:00Z');
    const daysSinceStart = Math.floor((currentDate - seasonStart) / (1000 * 60 * 60 * 24));
    const currentSeason = Math.floor(daysSinceStart / 90) + 1; // 90 days (3 months) per season

    // Create new empty leaderboard for next season
    const newTopScores = {
      top: [],
      last_updated: currentDate.toISOString(),
      season: currentSeason + 1,
      season_start: new Date(seasonStart.getTime() + (currentSeason * 90 * 24 * 60 * 60 * 1000)).toISOString()
    };

    const newLatestScore = {
      latest: null,
      last_updated: currentDate.toISOString(),
      season: currentSeason + 1
    };

    // Archive current season data
    const archiveData = {
      season: currentSeason,
      season_end: currentDate.toISOString(),
      top_scores: [], // Will be populated with current top scores
      total_players: 0
    };

    // Get current top scores for archive
    try {
      const topResponse = await octokit.repos.getContent({
        owner,
        repo,
        path: 'reaction/top.json',
        ref: branch
      });
      
      if (topResponse.data && topResponse.data.content) {
        const currentTop = JSON.parse(Buffer.from(topResponse.data.content, 'base64').toString());
        archiveData.top_scores = currentTop.top || [];
        archiveData.total_players = currentTop.top ? currentTop.top.length : 0;
      }
    } catch (error) {
      console.log('Could not fetch current top scores for archive:', error.message);
    }

    // Create archive file
    const archiveContent = Buffer.from(JSON.stringify(archiveData, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: `reaction/archive/season-${currentSeason}.json`,
      message: `Archive Season ${currentSeason} data`,
      content: archiveContent,
      branch
    });

    // Reset top.json
    const topContent = Buffer.from(JSON.stringify(newTopScores, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: 'reaction/top.json',
      message: `Reset leaderboard for Season ${currentSeason + 1}`,
      content: topContent,
      branch
    });

    // Reset latest.json
    const latestContent = Buffer.from(JSON.stringify(newLatestScore, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: 'reaction/latest.json',
      message: `Reset latest score for Season ${currentSeason + 1}`,
      content: latestContent,
      branch
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        message: `Season ${currentSeason} archived, Season ${currentSeason + 1} started`,
        archived_season: currentSeason,
        new_season: currentSeason + 1,
        archive_path: `reaction/archive/season-${currentSeason}.json`
      })
    };

  } catch (error) {
    console.error('Season reset error:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: false,
        error: 'Failed to reset season',
        details: error.message
      })
    };
  }
};

// Helper function to get GitHub token
async function getGitHubToken(appId, installationId, privateKey) {
  const jwt = require('jsonwebtoken');
  
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: appId
  };
  
  const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' });
  
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });
  
  const data = await response.json();
  return data.token;
}
