const crypto = require('crypto');

/**
 * Netlify Function: Save Reaction Test Score
 *
 * This function no longer commits directly to this repo. Instead:
 * 1. Validate incoming score data
 * 2. Generate a unique score record
 * 3. POST it to the static-encrypted-cms ingestion API (content.jovylle.com),
 *    which owns the live `fast-scores` collection
 * 4. Use the full merged leaderboard returned by that API to compute
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

    if (!process.env.CONTENT_INGEST_TOKEN) {
      throw new Error('CONTENT_INGEST_TOKEN is not configured');
    }

    // 2. Submit the score to the content API's fast-scores collection
    const ingestResponse = await fetch(
      `${CONTENT_API_BASE}/.netlify/functions/admin-json-file?collection=fast-scores`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.CONTENT_INGEST_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ collection: 'fast-scores', record: newScore })
      }
    );

    if (!ingestResponse.ok) {
      const errorBody = await ingestResponse.text();
      console.error('Content API rejected score:', ingestResponse.status, errorBody);
      throw new Error(`Content API request failed: ${ingestResponse.status}`);
    }

    const ingestResult = await ingestResponse.json();
    const scores = Array.isArray(ingestResult.data?.scores) ? ingestResult.data.scores : [];

    // Rank against the top N fastest times, mirroring the old top.json
    // semantics: fastest overall is a new record, position is this score's
    // 1-indexed rank within the top N once sorted ascending by ms.
    const rankedTop = [...scores].sort((a, b) => a.ms - b.ms).slice(0, TOP_N);
    const isNewRecord = ms <= (rankedTop[0]?.ms ?? Infinity);
    const position = rankedTop.findIndex(score => score.id === id) + 1;

    // 3. Return success response
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
 * CONTENT_INGEST_TOKEN - Bearer token for content.jovylle.com's fast-scores
 *                        ingestion API (a `fast-scores`-scoped, commit-write
 *                        entry in that project's INGEST_TOKENS env var)
 * CONTENT_API_BASE - Base URL of the content API (optional, defaults to
 *                    https://content.jovylle.com)
 *
 * Example .env:
 * CONTENT_INGEST_TOKEN=your-fast-scores-ingest-token
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
