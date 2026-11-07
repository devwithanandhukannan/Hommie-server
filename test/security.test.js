import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test('state-changing requests without a CSRF token are rejected', async () => {
  const c = new Client(srv.base);
  const r = await c.post('/auth/login', { email: 'a@b.com', password: 'x' }, { csrf: false });
  assert.equal(r.status, 403);
});

test('a CSRF header that does not match the cookie is rejected', async () => {
  const c = await new Client(srv.base).init();
  c.csrf = 'A'.repeat(43);
  const r = await c.post('/auth/login', { email: 'a@b.com', password: 'x' });
  assert.equal(r.status, 403);
});

test('a forged Origin is rejected even with a valid CSRF pair', async () => {
  const c = await new Client(srv.base).init();
  const r = await c.post('/auth/login', { email: 'a@b.com', password: 'x' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('private endpoints need a valid access token', async () => {
  const c = await new Client(srv.base).init();
  assert.equal((await c.get('/me')).status, 401);
  c.access = 'aaa.bbb.ccc';
  assert.equal((await c.get('/me')).status, 401);
});

test('NoSQL operator injection is blocked', async () => {
  const c = await new Client(srv.base).register('Victim', 'victim@example.com');
  const attacker = await new Client(srv.base).init();
  const r = await attacker.post('/auth/login', { email: { $ne: null }, password: { $ne: null } });
  assert.equal(r.status, 400);
  const r2 = await attacker.raw('POST', '/auth/login', { body: '{"email":"victim@example.com","password":{"$gt":""}}' });
  assert.equal(r2.status, 400);
  const r3 = await attacker.raw('POST', '/auth/login', { body: '{"__proto__":{"admin":true},"email":"a@b.com","password":"x"}' });
  assert.equal(r3.status, 400);
  void c;
});

test('unknown fields are rejected (no mass assignment)', async () => {
  const c = await new Client(srv.base).init();
  const r = await c.post('/auth/register', { name: 'Eve', email: 'eve@example.com', password: 'a-long-password-1', role: 'owner', tokenVersion: 99 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'Validation failed');
});

test('weak passwords and bad emails are refused', async () => {
  const c = await new Client(srv.base).init();
  assert.equal((await c.post('/auth/register', { name: 'A', email: 'a@example.com', password: 'short' })).status, 400);
  assert.equal((await c.post('/auth/register', { name: 'A', email: 'not-an-email', password: 'long-enough-password' })).status, 400);
});

test('responses never leak password hashes or tokens hashes', async () => {
  const c = await new Client(srv.base).register('Leak', 'leak@example.com');
  const me = await c.get('/me');
  const body = JSON.stringify(me.data);
  assert.ok(!/passwordHash|refreshHash|tokenVersion|resetHash/.test(body));
  assert.deepEqual(Object.keys(me.data).sort(), ['email', 'id', 'language', 'name']);
});

test('login: wrong password, lockout after 5 tries', async () => {
  await new Client(srv.base).register('Lock', 'lock@example.com', 'the-right-password-1');
  const c = await new Client(srv.base).init();
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/auth/login', { email: 'lock@example.com', password: 'wrong-password-1' })).status, 401);
  const r = await c.post('/auth/login', { email: 'lock@example.com', password: 'the-right-password-1' });
  assert.equal(r.status, 401, 'account is locked even with the right password');
});

test('refresh tokens rotate, and replaying an old one ends the session', async () => {
  const a = await new Client(srv.base).register('Rot', 'rot@example.com');
  const oldCookie = a.jar.get('fh_refresh');
  const r1 = await a.post('/auth/refresh', {});
  assert.equal(r1.status, 200);
  assert.notEqual(a.jar.get('fh_refresh'), oldCookie);
  // replay of the old cookie within the grace window is tolerated (parallel tab)...
  const thief = new Client(srv.base); await thief.init(); thief.jar.set('fh_refresh', oldCookie);
  assert.equal((await thief.post('/auth/refresh', {})).status, 200);
  // ...but after the grace window it revokes the whole session
  const { Session } = await import('../src/models/index.js');
  await Session.updateMany({}, { $set: { rotatedAt: new Date(Date.now() - 120_000) } });
  const thief2 = new Client(srv.base); await thief2.init(); thief2.jar.set('fh_refresh', oldCookie);
  assert.equal((await thief2.post('/auth/refresh', {})).status, 401);
  const legit = await a.post('/auth/refresh', {});
  assert.equal(legit.status, 401, 'the legitimate holder is logged out too (token theft suspected)');
});

test('changing the password revokes existing access tokens immediately', async () => {
  const c = await new Client(srv.base).register('Pw', 'pw@example.com', 'first-password-123');
  const token = c.access;
  assert.equal((await c.post('/me/password', { currentPassword: 'first-password-123', newPassword: 'second-password-456' })).status, 204);
  const old = new Client(srv.base); await old.init(); old.access = token;
  assert.equal((await old.get('/me')).status, 401);
});

test('security headers are present', async () => {
  const res = await fetch(srv.base + '/health');
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
});
