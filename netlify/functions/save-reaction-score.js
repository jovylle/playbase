const crypto = require('crypto');

/**
 * Netlify Function: Save Reaction Test Score
 *
 * This function no longer commits directly to this repo. Instead:
 * 1. Validate incoming score data
 * 2. Generate a unique score record
 * 3. POST it to content.jovylle.com's first-class `/api/scores` resource
 *    (D1-backed), which owns all `reaction` game scores
 * 4. Fetch the top-N leaderboard from that same API to compute
 *    isNewRecord/position for this score
 */

const CONTENT_API_BASE = process.env.CONTENT_API_BASE || 'https://content.jovylle.com';
const TOP_N = 10;

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
    // Math.random().toString(16) can yield fewer than 8 hex chars, which
    // the sibling API's schema now strictly rejects (^[a-f0-9]{8}$). This
    // always produces exactly 8 lowercase hex characters.
    const id = crypto.randomBytes(4).toString('hex');

    const newScore = {
      ms,
      timestamp,
      id,
      playerName: playerName || 'Anonymous',
      playerId: playerId || 'unknown'
    };

    if (!process.env.CONTENT_ADMIN_PASSWORD) {
      throw new Error('CONTENT_ADMIN_PASSWORD is not configured');
    }

    const authHeader = `Basic ${Buffer.from(`admin:${process.env.CONTENT_ADMIN_PASSWORD}`).toString('base64')}`;

    // 2. Submit the score to the content API's `reaction` scores
    const ingestResponse = await fetch(
      `${CONTENT_API_BASE}/api/scores`,
      {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          game: 'reaction',
          ms,
          playerName: newScore.playerName,
          playerId: newScore.playerId
        })
      }
    );

    if (!ingestResponse.ok) {
      const errorBody = await ingestResponse.text();
      console.error('Content API rejected score:', ingestResponse.status, errorBody);
      throw new Error(`Content API request failed: ${ingestResponse.status}`);
    }

    const inserted = await ingestResponse.json();
    // Use the API's own generated record (id/created_at) as the source of truth.
    newScore.id = inserted.id || id;
    newScore.timestamp = inserted.created_at || timestamp;

    // 3. Fetch the top-N leaderboard to compute isNewRecord/position
    const topResponse = await fetch(
      `${CONTENT_API_BASE}/api/scores?game=reaction&sort=top&limit=${TOP_N}`
    );

    if (!topResponse.ok) {
      const errorBody = await topResponse.text();
      console.error('Content API rejected top-scores fetch:', topResponse.status, errorBody);
      throw new Error(`Content API request failed: ${topResponse.status}`);
    }

    const topResult = await topResponse.json();
    const rankedTop = Array.isArray(topResult.scores) ? topResult.scores : [];

    // Rank against the top N fastest times, mirroring the old top.json
    // semantics: fastest overall is a new record, position is this score's
    // 1-indexed rank within the top N (already sorted ascending by ms).
    const isNewRecord = ms <= (rankedTop[0]?.ms ?? Infinity);
    const position = rankedTop.findIndex(score => score.id === newScore.id) + 1;

    // 4. Return success response
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
 * CONTENT_ADMIN_PASSWORD - Password used to build the `Authorization: Basic`
 *                          header (base64 of `admin:<password>`) for
 *                          content.jovylle.com's POST /api/scores endpoint
 * CONTENT_API_BASE - Base URL of the content API (optional, defaults to
 *                    https://content.jovylle.com)
 *
 * Example .env:
 * CONTENT_ADMIN_PASSWORD=your-content-admin-password
 * CONTENT_API_BASE=https://content.jovylle.com
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
