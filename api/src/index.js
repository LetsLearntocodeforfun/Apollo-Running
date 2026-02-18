const { app } = require('@azure/functions');

const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_SCOPES = 'activity:read_all,activity:write,profile:read_all';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Maximum allowed length for OAuth code and refresh token strings. */
const MAX_TOKEN_LENGTH = 256;

function getConfig() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  return { clientId, clientSecret, baseUrl };
}

app.http('strava-auth-url', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const { clientId, baseUrl } = getConfig();
    if (!clientId || !baseUrl) {
      return { status: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Server missing STRAVA_CLIENT_ID or BASE_URL' }) };
    }
    const redirectUri = `${baseUrl}/auth/strava/callback`;
    const url = `${STRAVA_AUTH_URL}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(STRAVA_SCOPES)}&approval_prompt=force`;
    return { headers: JSON_HEADERS, body: JSON.stringify({ url }) };
  },
});

app.http('strava-exchange', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const { clientId, clientSecret, baseUrl } = getConfig();
    if (!clientId || !clientSecret || !baseUrl) {
      return { status: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Server missing Strava configuration' }) };
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    const code = body && body.code;
    if (!code || typeof code !== 'string') {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Missing code' }) };
    }
    if (code.length > MAX_TOKEN_LENGTH) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid code length' }) };
    }
    const redirectUri = `${baseUrl}/auth/strava/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: code.trim(),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    const res = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { status: res.status, headers: JSON_HEADERS, body: JSON.stringify({ error: data.message || 'Strava token exchange failed' }) };
    }
    return { headers: JSON_HEADERS, body: JSON.stringify(data) };
  },
});

app.http('strava-refresh', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const { clientId, clientSecret } = getConfig();
    if (!clientId || !clientSecret) {
      return { status: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Server missing Strava configuration' }) };
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    const refreshToken = body && body.refresh_token;
    if (!refreshToken || typeof refreshToken !== 'string') {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Missing refresh_token' }) };
    }
    if (refreshToken.length > MAX_TOKEN_LENGTH) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid refresh_token length' }) };
    }
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken.trim(),
    });
    const res = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { status: res.status, headers: JSON_HEADERS, body: JSON.stringify({ error: data.message || 'Strava refresh failed' }) };
    }
    return { headers: JSON_HEADERS, body: JSON.stringify(data) };
  },
});
