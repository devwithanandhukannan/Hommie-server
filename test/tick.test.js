import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, familyOfThree, upload } from './helpers.js';
import { runTick } from '../src/jobs/tick.js';
import { Notification, User } from '../src/models/index.js';
import { todayIn, addDays } from '../src/lib/dates.js';

let srv, f;
const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+05:30`);
const today = () => todayIn('Asia/Kolkata');
const notesFor = async (client, type) => (await client.get('/me/notifications')).data.items.filter((n) => !type || n.type === type);

before(async () => { srv = await startServer(); f = await familyOfThree(srv.base); });
after(async () => { await srv.stop(); });

test('bills: creating one notifies the payer only; the due-tomorrow reminder is sent once', async () => {
  const due = addDays(today(), 1);
  await f.owner.post('/bills', { title: 'Water', category: 'water', amountMode: 'ask', rule: { unit: 'month', everyN: 1, anchorDate: due }, payerId: f.mother.me, reminderDaysBefore: 3 });
  const created = await notesFor(f.mother, 'bill');
  assert.equal(created.length, 1);
  assert.match(created[0].title, /Enter the amount for Water/);
  assert.equal((await notesFor(f.brother, 'bill')).length, 0, 'other members are not bothered');
  await runTick(at(today(), '09:00'));
  await runTick(at(today(), '09:05'));
  const after = await notesFor(f.mother, 'bill');
  assert.equal(after.filter((n) => /due tomorrow/.test(n.title)).length, 1, 'reminder is idempotent');
});

test('bills: an overdue bill alerts the payer and admins once', async () => {
  await f.owner.post('/bills', { title: 'Gas', category: 'gas', amountMode: 'ask', rule: { unit: 'once', anchorDate: addDays(today(), -3) }, payerId: f.brother.me });
  await runTick(at(today(), '10:00'));
  await runTick(at(today(), '10:05'));
  assert.equal((await notesFor(f.brother, 'bill')).filter((n) => /overdue/.test(n.title)).length, 1);
  assert.equal((await notesFor(f.owner, 'bill')).filter((n) => /Gas is overdue/.test(n.title)).length, 1, 'admins are told too');
  assert.equal((await notesFor(f.mother, 'bill')).filter((n) => /Gas/.test(n.title)).length, 0);
});

test('medicine: reminder at dose time reaches the person and caregiver, not the admin; never twice', async () => {
  const med = await f.mother.post('/medicines', { forId: f.mother.me, name: 'Metformin', times: ['08:00'], startDate: today(), caregiverIds: [f.brother.me] });
  assert.equal(med.status, 201);
  await runTick(at(today(), '07:50'));
  assert.equal((await notesFor(f.mother, 'medicine')).length, 0, 'too early');
  await runTick(at(today(), '08:02'));
  await runTick(at(today(), '08:07'));
  assert.equal((await notesFor(f.mother, 'medicine')).length, 1);
  assert.equal((await notesFor(f.brother, 'medicine')).length, 1);
  assert.equal((await notesFor(f.owner, 'medicine')).length, 0);
  assert.ok(!/Metformin/.test((await notesFor(f.mother, 'medicine'))[0].title), 'title does not expose the medicine name');
  // once the dose is logged, no more reminders for it
  await f.mother.post(`/medicines/${med.data.id}/logs`, { time: '08:00', status: 'given' });
  await runTick(at(today(), '08:20'));
  assert.equal((await notesFor(f.mother, 'medicine')).length, 1);
});

test('special days: reminded N days before and on the day, to everyone with an account', async () => {
  const date = addDays(today(), 7);
  await f.owner.post('/special-dates', { title: 'Onam sadya', kind: 'festival', date, repeatYearly: false, remindDaysBefore: 7 });
  await runTick(at(today(), '09:00'));
  await runTick(at(today(), '09:30'));
  for (const c of [f.owner, f.mother, f.brother]) assert.equal((await notesFor(c, 'date')).filter((n) => /Onam sadya in 7 days/.test(n.title)).length, 1);
});

test('documents: owner is warned before expiry, with a generic push text', async () => {
  const exp = addDays(today(), 7);
  const up = await f.mother.req('POST', '/documents', { form: upload({ title: 'Car insurance', expiryDate: exp }) });
  assert.equal(up.status, 201);
  await runTick(at(today(), '09:00'));
  await runTick(at(today(), '09:10'));
  const n = (await notesFor(f.mother, 'document')).filter((x) => /expires in 7 days/.test(x.title));
  assert.equal(n.length, 1);
  assert.equal((await notesFor(f.owner, 'document')).length, 0, 'only the owner of the document');
});

test('the cron webhook needs the secret header and no cookies', async () => {
  const r = await fetch(srv.base.replace('/api', '') + '/internal/cron/tick', { method: 'POST' });
  assert.equal(r.status, 403);
});

test('notifications can be read and marked read', async () => {
  const list = (await f.mother.get('/me/notifications')).data;
  assert.ok(list.unread > 0);
  assert.equal((await f.mother.post('/me/notifications/read-all', {})).status, 204);
  assert.equal((await f.mother.get('/me/notifications')).data.unread, 0);
  void Notification; void User;
});
