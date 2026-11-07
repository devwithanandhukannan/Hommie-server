import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, familyOfThree, upload } from './helpers.js';
import { todayIn, addDays } from '../src/lib/dates.js';

// Truly simultaneous requests are only atomic on real MongoDB/Atlas; set TEST_ATOMIC=1 when running against it.
const ATOMIC = process.env.TEST_ATOMIC === '1';
let srv, f; // f = { owner, mother, brother }
const today = () => todayIn('Asia/Kolkata');
before(async () => { srv = await startServer(); f = await familyOfThree(srv.base); });
after(async () => { await srv.stop(); });

test('IDOR: an outsider cannot use another family id, and ids from another family are 404', async () => {
  const outsider = await new Client(srv.base).register('Mallory', 'mallory@example.com');
  outsider.familyId = f.owner.familyId;
  assert.equal((await outsider.get('/tasks')).status, 403);
  assert.equal((await outsider.get('/families/current')).status, 403);
  await outsider.createFamily('Mallory Home');
  const t = await f.owner.post('/tasks', { title: 'Secret task' });
  assert.equal((await outsider.post(`/tasks/${t.data.id}/claim`, {})).status, 404);
  assert.equal((await outsider.del(`/tasks/${t.data.id}`)).status, 404);
  assert.equal((await outsider.get('/tasks')).data.length, 0);
});

test('roles: members cannot manage the family, owner can', async () => {
  assert.equal((await f.mother.post('/families/current/invites', {})).status, 403);
  assert.equal((await f.mother.patch('/families/current', { name: 'Hacked' })).status, 403);
  const fam = await f.owner.get('/families/current');
  const motherId = fam.data.members.find((m) => m.displayName === 'mother').membershipId;
  assert.equal((await f.mother.patch(`/families/current/members/${motherId}`, { role: 'admin' })).status, 403);
  assert.equal(fam.data.members.length, 3);
  assert.ok(!JSON.stringify(fam.data).includes('@example.com'), 'member emails are not exposed');
});

test('profile-only members can be added and linked by invite', async () => {
  const add = await f.owner.post('/families/current/members', { displayName: 'Ammamma', relation: 'grandparent' });
  assert.equal(add.status, 201);
  assert.equal(add.data.hasAccount, false);
  const inv = await f.owner.post('/families/current/invites', { linkToMembershipId: add.data.membershipId });
  const g = await new Client(srv.base).register('Grandma', 'grandma@example.com');
  const joined = await g.join(inv.data.code);
  assert.equal(joined.myMembershipId, add.data.membershipId, 'account attached to the existing profile');
});

test('invite codes are single use', async () => {
  const inv = await f.owner.post('/families/current/invites', {});
  const a = await new Client(srv.base).register('A1', 'a1@example.com');
  await a.join(inv.data.code);
  const b = await new Client(srv.base).register('B1', 'b1@example.com');
  assert.equal((await b.post('/families/accept-invite', { code: inv.data.code }, { family: false })).status, 400);
  assert.equal((await b.post('/families/accept-invite', { code: 'AAAA-BBBB-CCCC-DDDD' }, { family: false })).status, 400);
});

test('a user can switch between two families with separate data', async () => {
  const homeId = f.mother.familyId, homeMe = f.mother.me;
  await f.mother.createFamily('Flat 4B', 'rent');
  await f.mother.post('/tasks', { title: 'Pay maid' });
  const list = await f.mother.get('/overview', { family: false });
  assert.equal(list.data.length, 2);
  assert.equal((await f.mother.get('/tasks')).data.length, 1);
  f.mother.familyId = homeId; f.mother.me = homeMe;
  assert.ok(!(await f.mother.get('/tasks')).data.some((t) => t.title === 'Pay maid'));
});

test('tasks: claim is atomic, assign + complete with rotation', async () => {
  const t = await f.owner.post('/tasks', { title: 'Clean bathroom' });
  // Sequential double-claim (double tap / two people a second apart) must always be refused.
  const first = await f.mother.post(`/tasks/${t.data.id}/claim`, {});
  assert.equal(first.status, 200);
  assert.equal((await f.brother.post(`/tasks/${t.data.id}/claim`, {})).status, 409);
  const winner = f.mother, loser = f.brother;
  if (ATOMIC) {
    const t2 = await f.owner.post('/tasks', { title: 'Race task' });
    const [a, b] = await Promise.all([f.mother.post(`/tasks/${t2.data.id}/claim`, {}), f.brother.post(`/tasks/${t2.data.id}/claim`, {})]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], 'exactly one simultaneous claim wins');
  }
  assert.equal((await loser.post(`/tasks/${t.data.id}/complete`, {})).status, 403);
  assert.equal((await winner.post(`/tasks/${t.data.id}/complete`, {})).status, 200);
  assert.equal((await winner.post(`/tasks/${t.data.id}/complete`, {})).status, 409);

  const fam = (await f.owner.get('/families/current')).data.members.map((m) => m.membershipId);
  const r = await f.owner.post('/tasks', { title: 'Weekly cleaning', rotationOrder: fam, repeat: { unit: 'week', everyN: 1 }, dueDate: today() });
  assert.equal(r.status, 201);
  assert.equal(r.data.assignee.membershipId, fam[0]);
  assert.equal((await f.owner.post(`/tasks/${r.data.id}/complete`, {})).status, 200);
  const open = (await f.owner.get('/tasks?scope=open')).data.filter((x) => x.title === 'Weekly cleaning');
  assert.equal(open.length, 1);
  assert.equal(open[0].assignee.membershipId, fam[1], 'next week it is the next person');
  assert.ok(open[0].dueDate > today());
});

test('anyone can assign a task to someone else, but only to real members', async () => {
  const t = await f.mother.post('/tasks', { title: 'Buy gas' });
  const bro = (await f.owner.get('/families/current')).data.members.find((m) => m.displayName === 'brother');
  assert.equal((await f.mother.post(`/tasks/${t.data.id}/assign`, { membershipId: bro.membershipId })).status, 200);
  assert.equal((await f.mother.post(`/tasks/${t.data.id}/assign`, { membershipId: '0'.repeat(24) })).status, 400);
});

test('grocery: needs, bought-by tracking and optional price becomes an expense', async () => {
  const g = await f.owner.post('/grocery', { name: 'Eggs', qty: '12' });
  assert.equal(g.status, 201);
  assert.equal((await f.owner.post('/grocery', { name: '  eggs ' })).status, 200, 'same item is not duplicated');
  const bought = await f.mother.post(`/grocery/${g.data.id}/bought`, { price: 9000 });
  assert.equal(bought.data.status, 'stocked');
  assert.equal(bought.data.lastBought.by.displayName, 'mother');
  const e = (await f.owner.get(`/expenses?month=${today().slice(0, 7)}`)).data.find((x) => x.source === 'grocery');
  assert.equal(e.amount, 9000);
  assert.equal(e.split.reduce((a, s) => a + s.share, 0), 9000);
  const chat = await f.owner.get('/chat/messages');
  assert.ok(chat.data.items.some((m) => m.type === 'system' && m.text.includes('Eggs bought by mother')));
});

test('recipes can be shared, searched and added to the grocery list', async () => {
  const r = await f.mother.post('/recipes', { title: 'Sambar', ingredients: [{ name: 'Toor dal', qty: '1 cup' }, { name: 'Drumstick' }], steps: ['Boil dal'], tags: ['lunch'] });
  assert.equal(r.status, 201);
  assert.equal((await f.owner.get('/recipes?q=samb')).data.length, 1);
  assert.deepEqual((await f.owner.post(`/recipes/${r.data.id}/add-to-grocery`, {})).data, { added: 2, total: 2 });
  assert.equal((await f.brother.patch(`/recipes/${r.data.id}`, { title: 'x' })).status, 403);
});

test('meals: plan a day, mark yourself out, guests are counted', async () => {
  const d = today();
  assert.equal((await f.mother.put(`/meals/${d}/night`, { items: ['Chapati', 'Dal'] })).status, 200);
  await f.owner.post('/guests', { name: 'Uncle', from: d, to: addDays(d, 2) });
  const out = await f.brother.post(`/meals/${d}/night/attendance`, { status: 'out' });
  assert.equal(out.data.attendance[0].status, 'out');
  assert.equal((await f.brother.post(`/meals/${d}/night/attendance`, { status: 'out', memberId: f.owner.me })).status, 403);
  assert.equal((await f.owner.get(`/meals?from=${d}&to=${d}`)).data[0].guests, 1);
  assert.equal((await f.owner.get(`/meals?from=${d}&to=${addDays(d, 90)}`)).status, 400);
});

test('bills: custom recurring bill -> amount needed -> pay once -> expense + task + chat', async () => {
  const anchor = addDays(today(), 2);
  const mom = f.mother.me;
  const b = await f.owner.post('/bills', { title: 'Electricity', category: 'electricity', amountMode: 'ask', rule: { unit: 'month', everyN: 2, anchorDate: anchor }, payerId: mom, reminderDaysBefore: 3 });
  assert.equal(b.status, 201);
  assert.equal(b.data.nextDue, anchor);
  const inst = (await f.owner.get('/bill-instances')).data.find((i) => i.billTitle === 'Electricity');
  assert.equal(inst.status, 'awaiting_amount');
  assert.equal(inst.payer.membershipId, mom);
  assert.ok((await f.mother.get('/tasks?scope=mine')).data.some((t) => t.title === 'Enter Electricity amount' && t.kind === 'bill'));
  assert.equal((await f.brother.post(`/bill-instances/${inst.id}/amount`, { amount: 100000 })).status, 403, 'not the assignee');
  assert.equal((await f.mother.post(`/bill-instances/${inst.id}/pay`, {})).status, 400, 'amount first');
  assert.equal((await f.mother.post(`/bill-instances/${inst.id}/amount`, { amount: 184000 })).data.status, 'pending');
  assert.equal((await f.mother.get('/tasks?scope=mine')).data.find((t) => t.kind === 'bill').title, 'Pay Electricity · ₹1,840');
  assert.equal((await f.mother.post(`/bill-instances/${inst.id}/pay`, {})).status, 200);
  assert.equal((await f.mother.post(`/bill-instances/${inst.id}/pay`, {})).status, 409, 'paid exactly once');
  const exp = (await f.owner.get(`/expenses?month=${today().slice(0, 7)}`)).data.filter((e) => e.source === 'bill');
  assert.equal(exp.length, 1);
  assert.equal(exp[0].amount, 184000);
  assert.equal(exp[0].paidBy.displayName, 'mother');
  assert.equal(exp[0].split.reduce((a, s) => a + s.share, 0), 184000);
  assert.equal((await f.mother.get('/tasks?scope=mine')).data.filter((t) => t.kind === 'bill').length, 0, 'task closed');
  assert.ok((await f.owner.get('/chat/messages')).data.items.some((m) => m.text.includes('Electricity') && m.text.includes('paid by mother')));
});

test('bills: fixed-amount bills start pending; admin can record someone else paying', async () => {
  const b = await f.brother.post('/bills', { title: 'Internet', category: 'internet', amountMode: 'fixed', fixedAmount: 79900, rule: { unit: 'month', everyN: 1, anchorDate: addDays(today(), 1) }, reminderDaysBefore: 5 });
  assert.equal(b.status, 201);
  const inst = (await f.owner.get('/bill-instances')).data.find((i) => i.billTitle === 'Internet');
  assert.equal(inst.status, 'pending');
  assert.equal(inst.amount, 79900);
  assert.equal((await f.owner.post(`/bill-instances/${inst.id}/pay`, { paidById: f.mother.me })).status, 200);
  assert.equal((await f.mother.post('/bills', { title: 'X', rule: { unit: 'once', anchorDate: today() }, amountMode: 'fixed' })).status, 400, 'fixed needs amount');
  assert.equal((await f.mother.del(`/bills/${b.data.id}`)).status, 403, 'only creator or admin can delete');
});

test('tax: a yearly tax bill shows in the tax report', async () => {
  assert.equal((await f.owner.post('/bills', { title: 'House tax', category: 'tax', amountMode: 'ask', rule: { unit: 'year', everyN: 1, anchorDate: addDays(today(), 200) }, reminderDaysBefore: 30 })).status, 201);
  const rep = await f.owner.get('/reports/tax');
  assert.equal(rep.status, 200);
  assert.ok(rep.data.upcoming.some((x) => x.title === 'House tax'));
  assert.match(rep.data.financialYear, /^\d{4}-\d{2}$/);
});

test('loans: private loans are invisible to others; family loans create an EMI bill', async () => {
  const priv = await f.owner.post('/loans', { lender: 'SBI', principal: 50_000_000, interestRate: 8.5, emiDay: 5, startDate: '2025-01-05', tenureMonths: 120, visibility: 'private' });
  assert.equal(priv.status, 201);
  assert.ok(priv.data.emiAmount > 0, 'EMI suggested from principal, rate and tenure');
  assert.equal((await f.mother.get('/loans')).data.length, 0);
  assert.equal((await f.mother.get(`/loans/${priv.data.id}`)).status, 404);
  assert.equal((await f.mother.post(`/loans/${priv.data.id}/payments`, { paidOn: today(), amount: 100 })).status, 404);
  const pay = await f.owner.post(`/loans/${priv.data.id}/payments`, { paidOn: today(), amount: priv.data.emiAmount });
  assert.equal(pay.status, 201);
  assert.ok(pay.data.loan.outstanding < 50_000_000);
  assert.equal(pay.data.payment.interestPart + pay.data.payment.principalPart, priv.data.emiAmount);
  assert.ok(!(await f.mother.get('/bills')).data.some((b) => b.isLoanEmi), 'private loans create no family bill');
  await f.owner.post('/loans', { lender: 'Bike loan', principal: 8_000_000, interestRate: 10, emiAmount: 260000, emiDay: 10, startDate: today(), tenureMonths: 36, visibility: 'family' });
  assert.equal((await f.mother.get('/loans')).data.length, 1);
  assert.ok((await f.mother.get('/bills')).data.some((b) => b.isLoanEmi && b.title === 'Bike loan EMI'));
});

test('wallet: shared expenses and settlements produce correct balances', async () => {
  const [o, m, b] = [f.owner.me, f.mother.me, f.brother.me];
  const e = await f.owner.post('/expenses', { amount: 30000, category: 'food', date: today(), equalAmong: [o, m, b], note: 'Dinner out' });
  assert.equal(e.status, 201);
  assert.equal(e.data.split.reduce((a, s) => a + s.share, 0), 30000);
  assert.equal((await f.mother.post('/expenses', { amount: 1000, date: today(), paidById: o, equalAmong: [o] })).status, 403);
  assert.equal((await f.mother.post('/expenses', { amount: 1000, date: today(), split: [{ memberId: m, share: 400 }] })).status, 400, 'shares must add up');
  const before = (await f.mother.get('/wallet')).data;
  const st = await f.mother.post('/wallet/settlements', { toId: o, amount: 5000, date: today() });
  assert.equal(st.status, 201, JSON.stringify(st.data));
  const after = (await f.mother.get('/wallet')).data;
  assert.equal(after.me.net - before.me.net, 5000);
  assert.equal(after.balances.reduce((a, x) => a + x.net, 0), 0, 'balances always net to zero');
  const rep = (await f.owner.get(`/reports/monthly?month=${today().slice(0, 7)}`)).data;
  assert.ok(rep.total >= 30000);
  assert.ok(rep.byCategory.find((c) => c.category === 'food'));
});

test('documents: encrypted, private by default, shareable per person, access-logged', async () => {
  const up = await f.owner.req('POST', '/documents', { form: upload({ title: 'Aadhaar', category: 'identity', maskedNumber: 'XXXX XXXX 1234' }) });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const id = up.data.id;
  assert.equal(up.data.visibilityMode, 'private');
  assert.ok(!/enc|storageKey|data/.test(Object.keys(up.data).join(',')), 'no storage details in the DTO');
  const { Document } = await import('../src/models/index.js');
  const raw = await Document.findById(id).select('+data');
  assert.ok(!raw.data.includes(Buffer.from('secret family document body')), 'stored bytes are ciphertext');
  for (const c of [f.mother, f.brother]) {
    assert.equal((await c.get('/documents')).data.length, 0);
    assert.equal((await c.get(`/documents/${id}/file`)).status, 404);
    assert.equal((await c.patch(`/documents/${id}`, { visibilityMode: 'family' })).status, 404);
  }
  const dl = await f.owner.get(`/documents/${id}/file`);
  assert.equal(dl.status, 200);
  assert.match(dl.data.toString(), /secret family document body/);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await f.owner.patch(`/documents/${id}`, { visibilityMode: 'custom', allowedIds: [f.mother.me] })).status, 200);
  assert.equal((await f.mother.get('/documents')).data.length, 1);
  assert.equal((await f.mother.get(`/documents/${id}/file?inline=1`)).status, 200);
  assert.equal((await f.brother.get(`/documents/${id}/file`)).status, 404);
  assert.equal((await f.mother.del(`/documents/${id}`)).status, 403, 'a viewer cannot delete');
  const log = await f.owner.get(`/documents/${id}/access-log`);
  assert.ok(log.data.some((l) => l.by.displayName === 'mother' && l.action === 'view'));
  assert.equal((await f.mother.get(`/documents/${id}/access-log`)).status, 403);
  assert.equal((await f.owner.del(`/documents/${id}`)).status, 204);
});

test('documents: only real PDFs/images, size limit, masked numbers only', async () => {
  const fake = new Blob([Buffer.from('MZ\x90\x00 this is not a pdf at all, just text')], { type: 'application/pdf' });
  assert.equal((await f.owner.req('POST', '/documents', { form: upload({ title: 'Fake' }, fake, 'fake.pdf') })).status, 400);
  const huge = new Blob([Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024)])]);
  assert.equal((await f.owner.req('POST', '/documents', { form: upload({ title: 'Huge' }, huge) })).status, 413);
  assert.equal((await f.owner.req('POST', '/documents', { form: upload({ title: 'Full number', maskedNumber: '1234 5678 9012' }) })).status, 400, 'full ID numbers are refused');
  assert.equal((await f.owner.req('POST', '/documents', { form: upload({ title: 'Bad', visibilityMode: 'custom' }) })).status, 400, 'custom needs people');
  assert.equal((await f.owner.req('POST', '/documents', { form: upload({ title: 'Extra', isAdmin: 'true' }) })).status, 400, 'unknown form fields rejected');
});

test('chat: messages, unread counts, read receipts, cards and images', async () => {
  const before = (await f.brother.get('/chat/messages')).data.unread;
  const m = await f.mother.post('/chat/messages', { text: 'Dinner at 8?' });
  assert.equal(m.status, 201);
  assert.equal((await f.brother.get('/chat/messages')).data.unread, before + 1);
  await f.brother.post('/chat/read', {});
  const mine = (await f.mother.get('/chat/messages')).data.items.find((x) => x.id === m.data.id);
  assert.ok(mine.readByCount >= 1, 'brother has read it');
  const poll = await f.owner.get(`/chat/messages?after=${m.data.id}`);
  assert.equal(poll.data.items.filter((x) => x.id === m.data.id).length, 0, 'incremental polling returns only newer messages');
  assert.equal((await f.mother.post('/chat/messages', {})).status, 400);
  assert.equal((await f.mother.post('/chat/messages', { text: 'hi', extra: 1 })).status, 400);
  const task = await f.mother.post('/tasks', { title: 'Buy milk' });
  const card = await f.mother.post('/chat/messages', { ref: { kind: 'task', id: task.data.id } });
  assert.equal(card.data.type, 'card');
  assert.equal(card.data.ref.title, 'Buy milk');
  const other = await new Client(srv.base).register('Out', 'out@example.com'); await other.createFamily('Other');
  assert.equal((await other.post('/chat/messages', { ref: { kind: 'task', id: task.data.id } })).status, 400, 'cannot reference another family');
  const png = new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'), Buffer.alloc(32)], { type: 'image/png' });
  const att = await f.mother.req('POST', '/attachments', { form: upload({}, png, 'x.png') });
  assert.equal(att.status, 201);
  assert.equal((await f.mother.post('/chat/messages', { attachmentId: att.data.id })).data.type, 'image');
  assert.equal((await f.brother.get(`/attachments/${att.data.id}`)).status, 200);
  assert.equal((await other.get(`/attachments/${att.data.id}`)).status, 404);
  assert.equal((await f.brother.del(`/chat/messages/${m.data.id}`)).status, 403);
  assert.equal((await f.mother.del(`/chat/messages/${m.data.id}`)).status, 204);
});

test('medicine: visible only to the person, caregivers and creator; doses can be logged once', async () => {
  const time = '23:59';
  const med = await f.mother.post('/medicines', { forId: f.mother.me, name: 'BP tablet', dosage: '5mg', times: [time], startDate: today(), stock: 5, caregiverIds: [f.brother.me] });
  assert.equal(med.status, 201);
  assert.equal((await f.brother.get('/medicines')).data.length, 1, 'caregiver sees it');
  assert.equal((await f.owner.get('/medicines')).data.length, 0, 'the owner/admin does not');
  assert.equal((await f.owner.get('/medicines/today')).data.length, 0);
  assert.equal((await f.owner.post(`/medicines/${med.data.id}/logs`, { time, status: 'given' })).status, 404);
  assert.equal((await f.brother.get('/medicines/today')).data[0].status, 'pending');
  const log = await f.brother.post(`/medicines/${med.data.id}/logs`, { time, status: 'given' });
  assert.equal(log.status, 201);
  assert.equal(log.data.status, 'given');
  assert.equal((await f.brother.post(`/medicines/${med.data.id}/logs`, { time, status: 'given' })).status, 409);
  assert.equal((await f.mother.get('/medicines')).data[0].stock, 4, 'stock goes down');
  assert.equal((await f.mother.post(`/medicines/${med.data.id}/logs`, { time: '01:00', status: 'given' })).status, 400);
  assert.equal((await f.owner.get('/dashboard')).data.medicinesDueToday.length, 0);
});

test('special days, guests and contacts', async () => {
  const sd = await f.owner.post('/special-dates', { title: "Amma's birthday", kind: 'birthday', date: '1970-02-28', remindDaysBefore: 7, checklist: [{ text: 'Order cake' }] });
  assert.equal(sd.status, 201);
  assert.match(sd.data.nextDate, /^\d{4}-02-28$/);
  const done = await f.mother.patch(`/special-dates/${sd.data.id}/checklist/${sd.data.checklist[0].id}`, { done: true, assigneeId: f.mother.me });
  assert.equal(done.data.checklist[0].done, true);
  assert.equal((await f.owner.post('/contacts', { name: 'Dr. Nair', role: 'doctor', phone: '+91 98765 43210' })).status, 201);
  assert.equal((await f.owner.post('/contacts', { name: 'Bad', phone: '<script>' })).status, 400);
  assert.equal((await f.owner.post('/guests', { name: 'X', from: '2026-05-05', to: '2026-05-01' })).status, 400);
});

test('dashboard gives each member their own tasks, wallet and alerts', async () => {
  const d = (await f.mother.get('/dashboard')).data;
  assert.ok(Array.isArray(d.myTasks));
  assert.equal(typeof d.wallet.net, 'number');
  assert.ok(d.specialDatesSoon !== undefined && d.grocery && d.todayMeals !== undefined);
  assert.ok(d.myTasks.every((t) => t.assignee.membershipId === f.mother.me));
  assert.ok((await f.mother.get('/overview', { family: false })).data.every((x) => 'openTasksForMe' in x && 'unreadChat' in x));
});

test('leaving a family frees their tasks and removes access', async () => {
  const t = await f.owner.post('/tasks', { title: 'Mow lawn', assigneeId: f.brother.me });
  assert.equal((await f.brother.del(`/families/current/members/${f.brother.me}`)).status, 204);
  assert.equal((await f.brother.get('/tasks')).status, 403);
  assert.equal((await f.owner.get('/tasks')).data.find((x) => x.id === t.data.id).assignee, null);
});

test('owner cannot leave without transfer; deleting the family needs its name', async () => {
  assert.equal((await f.owner.del(`/families/current/members/${f.owner.me}`)).status, 400);
  assert.equal((await f.mother.post('/families/current/transfer', { membershipId: f.mother.me })).status, 403);
  assert.equal((await f.owner.del('/families/current', { confirmName: 'nope' })).status, 400);
  assert.equal((await f.owner.del('/families/current', { confirmName: 'Our Home' })).status, 204);
  assert.equal((await f.mother.get('/tasks')).status, 403);
});
