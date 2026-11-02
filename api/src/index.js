const { app } = require('@azure/functions');

const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
// v1.0.7 (PX-07): read-only — Apollo never writes to Strava.
const STRAVA_SCOPES = 'read,activity:read_all';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

/** Maximum allowed length for OAuth code and refresh token strings. */
const MAX_TOKEN_LENGTH = 256;
/** Printable OAuth token characters (rejects whitespace, control chars, and injection payloads). */
const SAFE_TOKEN_RE = /^[A-Za-z0-9._~+/-]+=*$/;
const STRAVA_FETCH_TIMEOUT_MS = 15_000;

function getConfig() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  return { clientId, clientSecret, baseUrl };
}

/**
 * Reply when Strava can't be reached or doesn't answer within STRAVA_FETCH_TIMEOUT_MS
 * (timeouts and network errors, including while the response body is still arriving).
 * The client gets a calm, generic message; only the error type is logged, never tokens or secrets.
 */
function stravaUnavailable(context, err) {
  context?.warn?.(`Strava token request failed: ${(err && err.name) || 'Error'}`);
  return { status: 504, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Could not reach Strava right now. Please try again in a moment.' }) };
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
    const rawCode = body && body.code;
    if (!rawCode || typeof rawCode !== 'string') {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Missing code' }) };
    }
    const code = rawCode.trim();
    if (!code || code.length > MAX_TOKEN_LENGTH || !SAFE_TOKEN_RE.test(code)) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid authorization code' }) };
    }
    const redirectUri = `${baseUrl}/auth/strava/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    let res;
    let data;
    try {
      res = await fetch(STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(STRAVA_FETCH_TIMEOUT_MS),
      });
      // A body that isn't JSON still becomes {}; a timeout or dropped connection while reading it does not.
      data = await res.json().catch((err) => {
        if (err instanceof SyntaxError) return {};
        throw err;
      });
    } catch (err) {
      return stravaUnavailable(context, err);
    }
    if (!res.ok) {
      const message = data && typeof data.message === 'string' && data.message;
      return { status: res.status, headers: JSON_HEADERS, body: JSON.stringify({ error: message || 'Strava token exchange failed' }) };
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
    const rawRefreshToken = body && body.refresh_token;
    if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Missing refresh_token' }) };
    }
    const refreshToken = rawRefreshToken.trim();
    if (!refreshToken || refreshToken.length > MAX_TOKEN_LENGTH || !SAFE_TOKEN_RE.test(refreshToken)) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Invalid refresh_token' }) };
    }
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    let res;
    let data;
    try {
      res = await fetch(STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(STRAVA_FETCH_TIMEOUT_MS),
      });
      // A body that isn't JSON still becomes {}; a timeout or dropped connection while reading it does not.
      data = await res.json().catch((err) => {
        if (err instanceof SyntaxError) return {};
        throw err;
      });
    } catch (err) {
      return stravaUnavailable(context, err);
    }
    if (!res.ok) {
      const message = data && typeof data.message === 'string' && data.message;
      return { status: res.status, headers: JSON_HEADERS, body: JSON.stringify({ error: message || 'Strava refresh failed' }) };
    }
    return { headers: JSON_HEADERS, body: JSON.stringify(data) };
  },
});
