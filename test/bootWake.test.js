import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureServerAwake, refreshSession, onServerStatusChange, setAccessToken } from '../../web/lib/api.js';

function withBrowserEnv(fetchImpl) {
  const prevWindow = globalThis.window;
  const prevNav = globalThis.navigator;
  const prevDoc = globalThis.document;
  const prevFetch = globalThis.fetch;

  const cookieJar = { value: '' };
  globalThis.window = {};
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true },
    configurable: true,
    writable: true,
  });
  globalThis.document = {
    get cookie() { return cookieJar.value; },
  };
  globalThis.fetch = fetchImpl;

  return {
    cookieJar,
    restore() {
      if (prevWindow === undefined) delete globalThis.window;
      else globalThis.window = prevWindow;
      if (prevNav === undefined) delete globalThis.navigator;
      else Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true, writable: true });
      if (prevDoc === undefined) delete globalThis.document;
      else globalThis.document = prevDoc;
      globalThis.fetch = prevFetch;
      setAccessToken(null);
    },
  };
}

test('ensureServerAwake resolves ready immediately when /api/health returns 200 without flashing boot state', async () => {
  const statuses = [];
  const off = onServerStatusChange((s) => statuses.push({ ...s }));
  const env = withBrowserEnv(async (url) => {
    assert.equal(url, '/api/health');
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  try {
    const res = await ensureServerAwake({ timeoutMs: 2000 });
    assert.equal(res, 'ready');
    assert.ok(statuses.every((s) => s.isBooting === false), 'never flips isBooting true on fast 200');
  } finally {
    off();
    env.restore();
  }
});

test('ensureServerAwake signals isBooting on 503/502 and waits until /api/health recovers to 200', async () => {
  const seenBooting = [];
  const off = onServerStatusChange((s) => seenBooting.push({ ...s }));
  let healthCalls = 0;

  const env = withBrowserEnv(async (url) => {
    assert.equal(url, '/api/health');
    healthCalls++;
    if (healthCalls === 1) return new Response('booting', { status: 503 });
    if (healthCalls === 2) return new Response('booting', { status: 502 });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  try {
    const res = await ensureServerAwake({ timeoutMs: 12000 });
    assert.equal(res, 'ready');
    assert.equal(healthCalls, 3);
    assert.ok(seenBooting.some((s) => s.isBooting === true && s.isWakingUp === true));
    assert.deepEqual(seenBooting.at(-1), { isBooting: false, isWakingUp: false });
  } finally {
    off();
    env.restore();
  }
});

test('refreshSession wakes server, recovers from a 403 CSRF mismatch by refetching CSRF, and logs out only on 401', async () => {
  let refreshCount = 0;
  let csrfCount = 0;

  const env = withBrowserEnv(async (url) => {
    if (url === '/api/health') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/auth/csrf') {
      csrfCount++;
      env.cookieJar.value = `fh_csrf=csrf-token-${csrfCount}`;
      return new Response(JSON.stringify({ csrfToken: `csrf-token-${csrfCount}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/auth/refresh') {
      refreshCount++;
      if (refreshCount === 1) {
        return new Response(JSON.stringify({ error: 'Invalid CSRF token' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      if (refreshCount === 2) {
        return new Response(JSON.stringify({ accessToken: 'acc-123', user: { id: 'u1', name: 'Anandhu' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'Expired' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  env.cookieJar.value = 'fh_csrf=stale-token';

  try {
    const user = await refreshSession();
    assert.deepEqual(user, { id: 'u1', name: 'Anandhu' });
    assert.equal(refreshCount, 2, 'retried /auth/refresh once after 403 CSRF recovery');
    assert.equal(csrfCount, 1, 'forced a fresh CSRF fetch');

    // Wait a tick for `refreshing = null` clear, then verify genuine 401 still logs out cleanly.
    await new Promise((r) => setTimeout(r, 10));
    const loggedOut = await refreshSession();
    assert.equal(loggedOut, null);
  } finally {
    env.restore();
  }
});

