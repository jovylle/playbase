const jwt = require('jsonwebtoken');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Debug: Check the private key format
    const privateKey = process.env.GITHUB_PRIVATE_KEY;
    
    console.log('Private key length:', privateKey ? privateKey.length : 'undefined');
    console.log('Private key starts with:', privateKey ? privateKey.substring(0, 50) : 'undefined');
    console.log('Has \\n?', privateKey ? privateKey.includes('\\n') : false);
    console.log('Has actual newlines?', privateKey ? privateKey.includes('\n') : false);

    // Try without replacement first
    const payload = {
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 600,
      iss: process.env.GITHUB_APP_ID
    };

    let jwtToken;
    try {
      // Try without newline replacement
      jwtToken = jwt.sign(payload, privateKey, { algorithm: 'RS256' });
      console.log('JWT created successfully without newline replacement');
    } catch (error) {
      console.log('Failed without replacement:', error.message);
      
      // Try with newline replacement
      try {
        const processedKey = privateKey.replace(/\\n/g, '\n');
        jwtToken = jwt.sign(payload, processedKey, { algorithm: 'RS256' });
        console.log('JWT created successfully WITH newline replacement');
      } catch (error2) {
        console.log('Failed with replacement too:', error2.message);
        return {
          statusCode: 500,
          body: JSON.stringify({ 
            error: 'Private key format issue',
            details: `Without replacement: ${error.message}, With replacement: ${error2.message}`
          })
        };
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true,
        message: 'JWT token created successfully',
        appId: process.env.GITHUB_APP_ID,
        installationId: process.env.GITHUB_INSTALLATION_ID
      })
    };

  } catch (error) {
    console.error('Function error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to test',
        details: error.message 
      })
    };
  }
};