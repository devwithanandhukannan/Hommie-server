import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/db.js';
import { createApp } from '../src/app.js';

export async function startServer() {
  const dbName = `fh_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await connectDb(`mongodb://127.0.0.1:27018/${dbName}`);
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return {
    base,
    async stop() {
      await new Promise((r) => server.close(r));
      await mongoose.connection.dropDatabase();
      await disconnectDb();
    },
  };
}

/** A tiny browser: keeps cookies, fetches a CSRF token, sends the access token and family header. */
export class Client {
  constructor(base) { this.base = base; this.jar = new Map(); this.access = null; this.csrf = null; this.familyId = null; this.user = null; }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (!v || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
  }
  async raw(method, path, { body, form, headers = {}, csrf = true, auth = true, family = true } = {}) {
    const h = { ...headers };
    if (csrf && this.csrf) h['x-csrf-token'] = this.csrf;
    if (auth && this.access) h.authorization = `Bearer ${this.access}`;
    if (family && this.familyId) h['x-family-id'] = this.familyId;
    const ck = this.cookieHeader();
    if (ck) h.cookie = ck;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h['content-type'] = 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const res = await fetch(this.base + path, { method, headers: h, body: payload });
    this.store(res);
    return res;
  }
  async req(method, path, opts) {
    const res = await this.raw(method, path, opts);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : res.status === 204 ? null : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get(p, o) { return this.req('GET', p, o); }
  post(p, body, o) { return this.req('POST', p, { ...o, body }); }
  put(p, body, o) { return this.req('PUT', p, { ...o, body }); }
  patch(p, body, o) { return this.req('PATCH', p, { ...o, body }); }
  del(p, body, o) { return this.req('DELETE', p, { ...o, body }); }
  async init() { const r = await this.get('/auth/csrf'); this.csrf = r.data.csrfToken; return this; }
  async register(name, email, password = 'correct-horse-battery') {
    await this.init();
    const r = await this.post('/auth/register', { name, email, password });
    if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.data)}`);
    this.access = r.data.accessToken; this.user = r.data.user;
    return this;
  }
  async createFamily(name = 'Our Home', type = 'home') {
    const r = await this.post('/families', { name, type }, { family: false });
    if (r.status !== 201) throw new Error(`family failed ${r.status} ${JSON.stringify(r.data)}`);
    this.familyId = r.data.id; this.me = r.data.myMembershipId;
    return r.data;
  }
  async join(code) {
    const r = await this.post('/families/accept-invite', { code }, { family: false });
    if (r.status !== 201) throw new Error(`join failed ${r.status} ${JSON.stringify(r.data)}`);
    this.familyId = r.data.id; this.me = r.data.myMembershipId;
    return r.data;
  }
}

/** Owner + 1 admin-created invite for a member: returns three ready clients in one family. */
export async function familyOfThree(base) {
  const owner = await new Client(base).register('Achan', `achan${Math.random().toString(36).slice(2)}@example.com`);
  await owner.createFamily('Our Home');
  const out = { owner };
  for (const [key, role] of [['mother', 'member'], ['brother', 'member']]) {
    const c = await new Client(base).register(key, `${key}${Math.random().toString(36).slice(2)}@example.com`);
    const inv = await owner.post('/families/current/invites', { role });
    if (inv.status !== 201) throw new Error('invite failed');
    await c.join(inv.data.code);
    out[key] = c;
  }
  return out;
}
export const pdf = () => new Blob([Buffer.from('%PDF-1.4\n%secret family document body\n%%EOF\n')], { type: 'application/pdf' });
export function upload(fields, blob = pdf(), name = 'doc.pdf') {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append('file', blob, name);
  return f;
}
