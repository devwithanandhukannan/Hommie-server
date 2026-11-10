import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import { Expense, Settlement, Notification, User, Session } from '../src/models/index.js';
import { computeFamilyBalances, monthlyExpenseSummary } from '../src/services/expenses.js';
import { compressJson } from '../src/middleware/compress.js';
import { subscribeSse, publishToUsers, publishFamilyChange } from '../src/services/events.js';
import { getCachedAiContext, setCachedAiContext } from '../src/services/aiCache.js';
import { signAccess } from '../src/lib/tokens.js';
import { me } from '../src/routes/auth.js';

function patchMethod(obj, key, replacement, restorers) {
  const orig = obj[key];
  obj[key] = replacement;
  restorers.push(() => { obj[key] = orig; });
}

test('computeFamilyBalances and monthlyExpenseSummary compute totals via MongoDB aggregations', async () => {
  const restorers = [];
  const FAM = '660000000000000000000001';
  const M1 = '660000000000000000000011';
  const M2 = '660000000000000000000012';

  try {
    let expCalls = 0;
    patchMethod(Expense, 'aggregate', async (pipeline) => {
      expCalls++;
      assert.ok(pipeline[0].$match.familyId instanceof mongoose.Types.ObjectId);
      if (pipeline[1]?.$unwind === '$split') {
        return [{ _id: M1, total: 600 }, { _id: M2, total: 600 }];
      }
      if (pipeline[1]?.$facet) {
        return [{
          total: [{ total: 2500 }],
          byCategory: [{ _id: 'grocery', total: 1500 }, { _id: 'bills', total: 1000 }],
          byPaid: [{ _id: M1, paid: 2500 }],
          byShare: [{ _id: M1, share: 1250 }, { _id: M2, share: 1250 }],
        }];
      }
      if (pipeline[0].$match.date?.$gte === '2026-10-01') {
        return [{ total: 2000 }];
      }
      return [{ _id: M1, total: 1200 }];
    }, restorers);

    patchMethod(Settlement, 'aggregate', async (pipeline) => {
      assert.ok(pipeline[0].$match.familyId instanceof mongoose.Types.ObjectId);
      return [{
        sent: [{ _id: M2, total: 200 }],
        received: [{ _id: M1, total: 200 }],
      }];
    }, restorers);

    const net = await computeFamilyBalances(FAM);
    assert.equal(expCalls, 2);
    // M1: +1200 paid - 600 share - 200 received = +400
    assert.equal(net.get(M1), 400);
    // M2: 0 paid - 600 share + 200 sent = -400
    assert.equal(net.get(M2), -400);

    const summary = await monthlyExpenseSummary(FAM, '2026-11', '2026-10');
    assert.equal(summary.total, 2500);
    assert.equal(summary.lastTotal, 2000);
    assert.deepEqual(summary.byCategory, [
      { category: 'grocery', total: 1500 },
      { category: 'bills', total: 1000 },
    ]);
    assert.deepEqual(summary.byMemberMap.get(M1), { paid: 2500, share: 1250 });
    assert.deepEqual(summary.byMemberMap.get(M2), { paid: 0, share: 1250 });
  } finally {
    restorers.reverse().forEach((fn) => fn());
  }
});

test('compressJson gzips JSON >= 1KB when Accept-Encoding includes gzip and leaves small payloads plain', async () => {
  const runCompress = (acceptEncoding, payload) => new Promise((resolve) => {
    const req = { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} };
    const headers = {};
    const res = {
      headersSent: false,
      getHeader: (k) => headers[k.toLowerCase()],
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      json(data) {
        resolve({ compressed: false, headers, data });
        return this;
      },
      end(buf) {
        res.headersSent = true;
        resolve({ compressed: true, headers, buf });
      },
    };
    compressJson(req, res, () => res.json(payload));
  });

  const small = await runCompress('gzip, deflate', { ok: true });
  assert.equal(small.compressed, false);

  const largePayload = { items: Array.from({ length: 40 }, (_, i) => ({ id: i, text: 'Household grocery item entry' })) };
  const plain = await runCompress('', largePayload);
  assert.equal(plain.compressed, false);

  const gz = await runCompress('gzip, br', largePayload);
  assert.equal(gz.compressed, true);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  const decoded = JSON.parse(zlib.gunzipSync(gz.buf).toString('utf8'));
  assert.deepEqual(decoded, largePayload);
});

test('events hub delivers user/family SSE updates, invalidates AI cache, and cleans up on close', () => {
  const FAM = '660000000000000000000009';
  const USER1 = '660000000000000000000091';
  setCachedAiContext(`${FAM}:m1`, { cached: true });
  assert.deepEqual(getCachedAiContext(`${FAM}:m1`), { cached: true });

  const makeMockStream = (userId, familyId) => {
    const req = new EventEmitter();
    req.ctx = { user: { _id: userId }, familyId };
    const chunks = [];
    const res = new EventEmitter();
    res.headers = {};
    res.statusCode = 0;
    res.status = (c) => { res.statusCode = c; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.flushHeaders = () => {};
    res.write = (c) => { chunks.push(c); return true; };
    return { req, res, chunks };
  };

  const client = makeMockStream(USER1, FAM);
  subscribeSse(client.req, client.res);
  assert.equal(client.res.statusCode, 200);
  assert.match(client.res.headers['Content-Type'], /text\/event-stream/);
  assert.match(client.chunks[0], /event: ready/);

  publishToUsers([USER1], { kind: 'notification', type: 'grocery' });
  assert.match(client.chunks.at(-1), /"kind":"notification"/);

  publishFamilyChange(FAM, 'grocery');
  assert.equal(getCachedAiContext(`${FAM}:m1`), null, 'AI cache invalidated immediately');
  assert.match(client.chunks.at(-1), /"kind":"grocery"/);

  // Disconnecting clears socket references cleanly without throwing on future publishes.
  client.req.emit('close');
  const countBefore = client.chunks.length;
  publishFamilyChange(FAM, 'tasks');
  assert.equal(client.chunks.length, countBefore);
});

test('me notification pagination (?before, hasMore) and clear read endpoints work', async () => {
  const restorers = [];
  const USER_ID = '660000000000000000000051';
  const SESSION_ID = '660000000000000000000052';
  const BEFORE_ID = '660000000000000000000500';
  const token = signAccess({ _id: USER_ID, tokenVersion: 0 }, SESSION_ID);
  let capturedFilter = null;
  let deletedFilter = null;

  const invokeMe = (method, url, query = {}) => new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}` };
    const req = {
      method,
      url,
      originalUrl: url,
      baseUrl: '',
      headers,
      get(k) { return headers[k.toLowerCase()]; },
      query,
      params: {},
      body: {},
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { this.body = d; resolve(this); return this; },
      end() { resolve(this); return this; },
    };
    me(req, res, (err) => (err ? reject(err) : resolve(res)));
  });

  try {
    patchMethod(User, 'findById', async () => ({ _id: USER_ID, tokenVersion: 0 }), restorers);
    patchMethod(Session, 'findById', () => ({
      select: async () => ({
        _id: SESSION_ID,
        userId: USER_ID,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    }), restorers);
    patchMethod(Notification, 'find', (filter) => {
      capturedFilter = filter;
      return {
        sort: () => ({
          limit: () => ({
            lean: async () => [
              { _id: 'n1', type: 'grocery', title: 'A', body: '', url: '/grocery', readAt: null, createdAt: new Date() },
              { _id: 'n2', type: 'task', title: 'B', body: '', url: '/tasks', readAt: new Date(), createdAt: new Date() },
              { _id: 'n3', type: 'chat', title: 'C', body: '', url: '/chat', readAt: new Date(), createdAt: new Date() },
            ],
          }),
        }),
      };
    }, restorers);
    patchMethod(Notification, 'countDocuments', async () => 1, restorers);
    patchMethod(Notification, 'deleteMany', async (filter) => {
      deletedFilter = filter;
      return { deletedCount: 2 };
    }, restorers);

    const listRes = await invokeMe('GET', `/notifications?before=${BEFORE_ID}&limit=2`, { before: BEFORE_ID, limit: '2' });
    assert.equal(listRes.statusCode, 200);
    assert.deepEqual(capturedFilter, { userId: USER_ID, _id: { $lt: BEFORE_ID } });
    assert.equal(listRes.body.hasMore, true);
    assert.equal(listRes.body.items.length, 2);
    assert.equal(listRes.body.unread, 1);

    const clearRes = await invokeMe('DELETE', '/notifications', {});
    assert.equal(clearRes.statusCode, 204);
    assert.deepEqual(deletedFilter, { userId: USER_ID, readAt: { $ne: null } });
  } finally {
    restorers.reverse().forEach((fn) => fn());
  }
});
