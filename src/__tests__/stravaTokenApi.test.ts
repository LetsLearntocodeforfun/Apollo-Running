/**
 * The optional self-hosted Strava sign-in function (api/src/index.js, Azure
 * Functions): token checks before Strava is called, `Cache-Control: no-store`
 * on every reply, a calm `504` when Strava can't be reached or doesn't answer
 * in time (also while the reply is still arriving), Strava's own status for
 * its errors, and nothing secret in replies or logs. The file is run with a
 * stand-in for `@azure/functions` that only records the handlers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ApiReply {
  status?: number;
  headers: Record<string, string>;
  body: string;
}
type ApiHandler = (
  request: { json: () => Promise<unknown> },
  context?: { warn?: (message: string) => void },
) => Promise<ApiReply>;

const CLIENT_SECRET = 'client-secret-never-leaves';
const UNAVAILABLE = '{"error":"Could not reach Strava right now. Please try again in a moment."}';

/** Run api/src/index.js (CommonJS) with a stand-in `@azure/functions`; returns its handlers by name. */
function loadApiHandlers(): Record<string, ApiHandler> {
  const handlers: Record<string, ApiHandler> = {};
  const azureFunctions = {
    app: {
      http: (name: string, options: { handler: ApiHandler }) => {
        handlers[name] = options.handler;
      },
    },
  };
  const fakeRequire = (id: string) => {
    if (id === '@azure/functions') return azureFunctions;
    throw new Error(`Unexpected require("${id}") in api/src/index.js`);
  };
  const source = readFileSync(path.resolve(__dirname, '../../api/src/index.js'), 'utf8');
  const commonJsModule = { exports: {} };
  new Function('require', 'module', 'exports', source)(fakeRequire, commonJsModule, commonJsModule.exports);
  return handlers;
}

const handlers = loadApiHandlers();
const ENDPOINTS: [name: string, body: Record<string, unknown>][] = [
  ['strava-exchange', { code: 'a1b2c3d4e5' }],
  ['strava-refresh', { refresh_token: 'r3fr3sh-t0k3n' }],
];
const request = (body: unknown) => ({ json: async () => body });

function failure(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

describe('Strava token API (api/src/index.js)', () => {
  let logs: string[];
  let context: { warn: (message: string) => void };

  beforeEach(() => {
    vi.stubEnv('STRAVA_CLIENT_ID', '12345');
    vi.stubEnv('STRAVA_CLIENT_SECRET', CLIENT_SECRET);
    vi.stubEnv('BASE_URL', 'https://apollo.example/');
    logs = [];
    context = { warn: (message) => logs.push(message) };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('answers a timeout, a network error or a reply cut off midway with a calm 504', async () => {
    const cutOff = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"access_tok'));
            controller.error(failure('TimeoutError', 'The operation was aborted due to timeout'));
          },
        }),
        { status: 200 },
      );
    for (const [label, fetchImpl] of [
      ['timeout', () => Promise.reject(failure('TimeoutError', 'The operation was aborted due to timeout'))],
      ['network error', () => Promise.reject(new TypeError('fetch failed'))],
      ['reply cut off', () => Promise.resolve(cutOff())],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(fetchImpl));
      for (const [name, body] of ENDPOINTS) {
        const reply = await handlers[name](request(body), context);
        expect(reply.status, `${name}: ${label}`).toBe(504);
        expect(reply.body).toBe(UNAVAILABLE);
        expect(reply.headers['Cache-Control']).toBe('no-store');
      }
    }
    // Only the kind of error is logged: no tokens, codes or secrets
    expect(logs.length).toBe(6);
    for (const line of logs) expect(line).toMatch(/^Strava token request failed: (TimeoutError|TypeError)$/);
    // Without a context object the 504 path still answers
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    expect((await handlers['strava-refresh'](request({ refresh_token: 'abc' }))).status).toBe(504);
  });

  it("passes Strava's status and text message on, and copes with an odd error body", async () => {
    const replyWith = (status: number, text: string) => vi.fn(async () => new Response(text, { status }));
    for (const [status, text, error] of [
      [400, '{"message":"Bad Request","errors":[]}', 'Bad Request'],
      [401, 'null', null],
      [429, '{"message":{"detail":"x"}}', null],
      [502, '<html>Bad gateway</html>', null],
    ] as const) {
      vi.stubGlobal('fetch', replyWith(status, text));
      const exchange = await handlers['strava-exchange'](request({ code: 'abc' }), context);
      expect(exchange.status).toBe(status);
      expect(exchange.headers['Cache-Control']).toBe('no-store');
      expect(JSON.parse(exchange.body)).toEqual({ error: error ?? 'Strava token exchange failed' });
      const refresh = await handlers['strava-refresh'](request({ refresh_token: 'abc' }), context);
      expect(refresh.status).toBe(status);
      expect(JSON.parse(refresh.body)).toEqual({ error: error ?? 'Strava refresh failed' });
    }
  });

  it('returns the tokens as Strava sent them, never cached, with the secret sent only to Strava', async () => {
    const tokens = '{"access_token":"a","refresh_token":"r","expires_at":1}';
    const fetchMock = vi.fn(async () => new Response(tokens, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    for (const [name, body] of ENDPOINTS) {
      const reply = await handlers[name](request(body), context);
      expect(reply.status ?? 200).toBe(200);
      expect(reply.body).toBe(tokens);
      expect(reply.headers).toMatchObject({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
      expect(reply.body).not.toContain(CLIENT_SECRET);
    }
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[0]).toBe('https://www.strava.com/oauth/token');
      expect(call[1].signal).toBeInstanceOf(AbortSignal); // the 15 s timeout
    }
  });

  it('refuses malformed codes and refresh tokens before calling Strava', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const bad of [undefined, 42, '', '   ', 'has space', 'line\nbreak', '<script>', 'x'.repeat(257)]) {
      const exchange = await handlers['strava-exchange'](request({ code: bad }), context);
      expect(exchange.status, JSON.stringify(bad)).toBe(400);
      expect(exchange.headers['Cache-Control']).toBe('no-store');
      const refresh = await handlers['strava-refresh'](request({ refresh_token: bad }), context);
      expect(refresh.status, JSON.stringify(bad)).toBe(400);
    }
    const notJson = { json: async () => Promise.reject(new SyntaxError('Unexpected token')) };
    expect((await handlers['strava-exchange'](notJson, context)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports missing server settings without revealing any of them', async () => {
    vi.stubEnv('STRAVA_CLIENT_ID', '');
    for (const [name, body] of ENDPOINTS) {
      const reply = await handlers[name](request(body), context);
      expect(reply.status).toBe(500);
      expect(reply.headers['Cache-Control']).toBe('no-store');
      expect(reply.body).not.toContain(CLIENT_SECRET);
    }
  });
});
