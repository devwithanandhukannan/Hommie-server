import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNotification } from '../src/lib/notifI18n.js';
import { notify, otherFamilyUserIds } from '../src/services/push.js';
import { User, Notification, Membership, Task, GroceryItem, Medicine, ChatMessage } from '../src/models/index.js';
import { tasks } from '../src/routes/tasks.js';
import { grocery } from '../src/routes/grocery.js';
import { medicines } from '../src/routes/medicine.js';
import { ai } from '../src/routes/ai.js';
import { translateNotificationText } from '../../web/lib/i18n.js';

function invokeRouter(router, { method, url, body = {}, params = {}, ctx }) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      originalUrl: url,
      baseUrl: '',
      headers: {},
      query: {},
      params,
      body,
      ctx,
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; resolve(this); return this; },
      end() { resolve(this); return this; },
    };
    router(req, res, (err) => (err ? reject(err) : resolve(res)));
  });
}

function patchMethod(obj, key, replacement, restorers) {
  const orig = obj[key];
  obj[key] = replacement;
  restorers.push(() => { obj[key] = orig; });
}

function mockUserFind(users, restorers, onFind) {
  patchMethod(User, 'find', (filter) => {
    onFind?.(filter);
    const ids = (filter?._id?.$in || []).map(String);
    return {
      select: () => ({
        lean: async () => ids.map((id) => users.get(id)).filter(Boolean),
      }),
    };
  }, restorers);
}

test('renderNotification formats new event templates in en, ml, ta, and hi', () => {
  const en = renderNotification({
    i18nKey: 'grocery_added',
    params: { by: 'Dhanya', name: 'Milk', qty: '2 L' },
  }, 'en');
  assert.equal(en.title, 'Dhanya added to grocery list');
  assert.equal(en.body, 'Milk (2 L)');
  assert.equal(en.pushBody, 'Milk (2 L)');

  const ml = renderNotification({
    i18nKey: 'grocery_added',
    params: { by: 'Dhanya', name: 'Milk', qty: '' },
  }, 'ml');
  assert.equal(ml.title, 'Dhanya പലചരക്ക് ലിസ്റ്റിൽ ചേർത്തു');
  assert.equal(ml.body, 'Milk');

  const ta = renderNotification({
    i18nKey: 'grocery_batch',
    params: { by: 'Dhanya', count: 3, preview: 'Rice, Dal, Oil' },
  }, 'ta');
  assert.equal(ta.title, 'Dhanya 3 மளிகைப் பொருட்களைச் சேர்த்தார்');
  assert.equal(ta.body, 'Rice, Dal, Oil');

  const hi = renderNotification({
    i18nKey: 'task_open',
    params: { by: 'Ravi', title: 'Buy gas cylinder' },
  }, 'hi');
  assert.equal(hi.title, 'Ravi ने सभी के लिए एक कार्य जोड़ा');
  assert.equal(hi.body, 'Buy gas cylinder');

  // Unknown language falls back safely to English.
  const fallback = renderNotification({
    i18nKey: 'task_assigned',
    params: { by: 'Ravi', title: 'Clean kitchen' },
  }, 'fr');
  assert.equal(fallback.title, 'Ravi gave you a task');
  assert.equal(fallback.body, 'Clean kitchen');

  assert.equal(
    renderNotification({ i18nKey: 'task_due_today', params: { title: 'Pay rent', dueDate: '2026-11-10' } }, 'ml').title,
    'ഇന്ന് ചെയ്യേണ്ട ജോലി: Pay rent',
  );
  assert.equal(
    renderNotification({ i18nKey: 'task_overdue', params: { title: 'Clean tank', dueDate: '2026-11-08' } }, 'ta').title,
    'காலாவதியான பணி: Clean tank',
  );
});

test('renderNotification medicine_added keeps lock-screen pushBody free of medicine name', () => {
  for (const lang of ['en', 'ml', 'ta', 'hi']) {
    const out = renderNotification({
      i18nKey: 'medicine_added',
      params: { by: 'Anandhu', forName: 'Amma', name: 'Metformin', times: '08:00, 20:00' },
    }, lang);
    assert.match(out.body, /Metformin/);
    assert.ok(!out.pushBody.includes('Metformin'), `pushBody leaked drug name for ${lang}`);
  }
});

test('renderNotification translates legacy strings per recipient language', () => {
  assert.equal(
    renderNotification({ title: 'Electricity is due today', body: 'Amount still needed' }, 'ml').title,
    'Electricity ഇന്ന് അടയ്ക്കണം',
  );
  assert.equal(
    renderNotification({ title: 'Medicine time', body: 'Dose due at 08:00' }, 'ta').body,
    'மருந்து நேரம்: 08:00',
  );
  assert.equal(
    renderNotification({ title: 'A document expires in 5 days', body: 'Open the app to see it' }, 'hi').title,
    'एक दस्तावेज़ 5 दिनों में समाप्त होगा',
  );
});

test('notify stores localized Notification per recipient language and supports coalesce', async () => {
  const restorers = [];
  const created = [];
  const updated = [];
  const users = new Map([
    ['u-en', { _id: 'u-en', language: 'en', mutedFamilies: [], push: [] }],
    ['u-ml', { _id: 'u-ml', language: 'ml', mutedFamilies: ['fam1'], push: [] }],
    ['u-ta', { _id: 'u-ta', language: 'ta', mutedFamilies: [], push: [] }],
    ['u-hi', { _id: 'u-hi', language: 'hi', mutedFamilies: [], push: [] }],
  ]);

  let userFindCalls = 0;
  try {
    mockUserFind(users, restorers, () => { userFindCalls++; });
    patchMethod(Notification, 'findOneAndUpdate', async (filter, update) => {
      if (filter.userId === 'u-en') {
        updated.push({ filter, update });
        return { _id: 'existing' };
      }
      return null;
    }, restorers);
    patchMethod(Notification, 'create', async (doc) => {
      created.push(doc);
      return doc;
    }, restorers);

    // Muted family only suppresses type === 'chat', NOT grocery.
    await notify({
      userIds: ['u-en', 'u-ml', 'u-ta', 'u-hi'],
      familyId: 'fam1',
      type: 'grocery',
      url: '/grocery',
      coalesce: true,
      i18nKey: 'grocery_added',
      params: { by: 'Dhanya', name: 'Onions', qty: '1 kg' },
    });

    assert.equal(userFindCalls, 1, 'notify batches all recipients into a single User.find query');
    assert.equal(updated.length, 1);
    assert.equal(updated[0].update.$set.title, 'Dhanya added to grocery list');

    assert.equal(created.length, 3);
    assert.equal(created.find((c) => c.userId === 'u-ml').title, 'Dhanya പലചരക്ക് ലിസ്റ്റിൽ ചേർത്തു');
    assert.equal(created.find((c) => c.userId === 'u-ta').title, 'Dhanya மளிகைப் பட்டியலில் சேர்த்தார்');
    assert.equal(created.find((c) => c.userId === 'u-hi').title, 'Dhanya ने किराना सूची में जोड़ा');

    // Muted family SHOULD suppress chat notification for u-ml.
    created.length = 0;
    await notify({
      userIds: ['u-ml', 'u-hi'],
      familyId: 'fam1',
      type: 'chat',
      url: '/chat',
      i18nKey: undefined,
      title: 'Dhanya: new messages',
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].userId, 'u-hi');
    assert.equal(created[0].title, 'Dhanya: नए संदेश');
  } finally {
    restorers.reverse().forEach((fn) => fn());
  }
});

test('otherFamilyUserIds returns active linked userIds excluding caller', async () => {
  const restorers = [];
  let capturedFilter = null;
  try {
    patchMethod(Membership, 'find', (filter) => {
      capturedFilter = filter;
      return {
        select: () => ({
          lean: async () => [{ userId: 'u-2' }, { userId: 'u-3' }],
        }),
      };
    }, restorers);

    const ids = await otherFamilyUserIds('fam-1', 'mem-1');
    assert.deepEqual(ids, ['u-2', 'u-3']);
    assert.deepEqual(capturedFilter, {
      familyId: 'fam-1',
      status: 'active',
      userId: { $ne: null },
      _id: { $ne: 'mem-1' },
    });
  } finally {
    restorers.reverse().forEach((fn) => fn());
  }
});

test('routes trigger localized notifications for grocery, medicine (privacy-safe), and unassigned/all tasks', async () => {
  const restorers = [];
  const notifications = [];

  const FAM = '660000000000000000000001';
  const ME = '660000000000000000000011';
  const MOTHER = '660000000000000000000012';
  const BROTHER = '660000000000000000000013';
  const ADMIN = '660000000000000000000014';

  const members = [
    { _id: ME, familyId: FAM, displayName: 'Dhanya', relation: 'mother', role: 'member', userId: 'u-me', status: 'active' },
    { _id: MOTHER, familyId: FAM, displayName: 'Amma', relation: 'grandmother', role: 'member', userId: 'u-amma', status: 'active' },
    { _id: BROTHER, familyId: FAM, displayName: 'Ravi', relation: 'son', role: 'member', userId: 'u-ravi', status: 'active' },
    { _id: ADMIN, familyId: FAM, displayName: 'Anandhu', relation: 'father', role: 'admin', userId: 'u-admin', status: 'active' },
  ];
  const users = new Map([
    ['u-me', { _id: 'u-me', language: 'en', mutedFamilies: [], push: [] }],
    ['u-amma', { _id: 'u-amma', language: 'ml', mutedFamilies: [], push: [] }],
    ['u-ravi', { _id: 'u-ravi', language: 'ta', mutedFamilies: [], push: [] }],
    ['u-admin', { _id: 'u-admin', language: 'hi', mutedFamilies: [], push: [] }],
  ]);

  const ctx = {
    familyId: FAM,
    me: ME,
    role: 'member',
    membership: { _id: ME, displayName: 'Dhanya' },
    family: { _id: FAM, timezone: 'Asia/Kolkata' },
  };

  try {
    mockUserFind(users, restorers);
    patchMethod(Notification, 'findOneAndUpdate', async () => null, restorers);
    patchMethod(Notification, 'create', async (doc) => {
      notifications.push(doc);
      return doc;
    }, restorers);
    patchMethod(Membership, 'countDocuments', async (q) => q._id?.$in?.length || 0, restorers);
    patchMethod(Membership, 'find', (filter) => {
      const list = members.filter((m) => (!filter._id?.$ne || String(m._id) !== String(filter._id.$ne)));
      return {
        sort: async () => list,
        select: () => ({ lean: async () => list }),
      };
    }, restorers);

    // 1. POST /grocery notifies every other active member in their chosen language
    patchMethod(GroceryItem, 'findOne', async () => null, restorers);
    patchMethod(GroceryItem, 'create', async (doc) => ({
      _id: '660000000000000000000101',
      ...doc,
      imageUrl: '',
      boughtCount: 0,
    }), restorers);

    const gRes = await invokeRouter(grocery, {
      method: 'POST',
      url: '/',
      body: { name: 'Coconut Oil', qty: '1 bottle' },
      ctx,
    });
    assert.equal(gRes.statusCode, 201);
    assert.deepEqual(
      notifications.map((n) => [n.userId, n.type, n.title]),
      [
        ['u-amma', 'grocery', 'Dhanya പലചരക്ക് ലിസ്റ്റിൽ ചേർത്തു'],
        ['u-ravi', 'grocery', 'Dhanya மளிகைப் பட்டியலில் சேர்த்தார்'],
        ['u-admin', 'grocery', 'Dhanya ने किराना सूची में जोड़ा'],
      ],
    );

    // 2. POST /medicines notifies only patient (forId) + caregivers, NOT creator & NOT unrelated admin
    notifications.length = 0;
    patchMethod(Medicine, 'create', async (doc) => ({
      _id: '660000000000000000000201',
      ...doc,
      active: true,
    }), restorers);

    const mRes = await invokeRouter(medicines, {
      method: 'POST',
      url: '/',
      body: {
        forId: MOTHER,
        name: 'Amlodipine',
        dosage: '5 mg',
        times: ['08:00'],
        days: [],
        startDate: '2026-11-10',
        caregiverIds: [ME, BROTHER],
      },
      ctx,
    });
    assert.equal(mRes.statusCode, 201);
    assert.deepEqual(notifications.map((n) => n.userId), ['u-amma', 'u-ravi']);
    assert.equal(notifications[0].type, 'medicine_added');
    assert.equal(notifications[0].title, 'Dhanya മരുന്ന് ഷെഡ്യൂൾ ചേർത്തു');
    assert.equal(notifications[1].title, 'Dhanya மருந்து அட்டவணையைச் சேர்த்தார்');

    // 3. POST /tasks with unassigned / all (assigneeId: null) notifies everyone else
    notifications.length = 0;
    patchMethod(Task, 'create', async (doc) => ({
      _id: '660000000000000000000301',
      ...doc,
      status: 'open',
      toObject() { return this; },
    }), restorers);

    const tRes = await invokeRouter(tasks, {
      method: 'POST',
      url: '/',
      body: { title: 'Water the plants', assigneeId: null },
      ctx,
    });
    assert.equal(tRes.statusCode, 201);
    assert.deepEqual(
      notifications.map((n) => [n.userId, n.type, n.title]),
      [
        ['u-amma', 'task', 'Dhanya എല്ലാവർക്കുമായി ഒരു ജോലി ചേർത്തു'],
        ['u-ravi', 'task', 'Dhanya அனைவருக்கும் ஒரு பணியைச் சேர்த்தார்'],
        ['u-admin', 'task', 'Dhanya ने सभी के लिए एक कार्य जोड़ा'],
      ],
    );
  } finally {
    restorers.reverse().forEach((fn) => fn());
  }
});

test('POST /ai/apply sends localized grocery_batch, task_open, and task_assigned notifications', async () => {
  const restorers = [];
  const notifications = [];

  const FAM = '660000000000000000000002';
  const ME = '660000000000000000000021';
  const AMMA = '660000000000000000000022';
  const RAVI = '660000000000000000000023';

  const members = [
    { _id: ME, familyId: FAM, displayName: 'Dhanya', relation: 'mother', role: 'member', userId: 'u-me', status: 'active' },
    { _id: AMMA, familyId: FAM, displayName: 'Amma', relation: 'grandmother', role: 'member', userId: 'u-amma', status: 'active' },
    { _id: RAVI, familyId: FAM, displayName: 'Ravi', relation: 'son', role: 'member', userId: 'u-ravi', status: 'active' },
  ];
  const users = new Map([
    ['u-me', { _id: 'u-me', language: 'en', mutedFamilies: [], push: [] }],
    ['u-amma', { _id: 'u-amma', language: 'ml', mutedFamilies: [], push: [] }],
    ['u-ravi', { _id: 'u-ravi', language: 'ta', mutedFamilies: [], push: [] }],
  ]);

  const ctx = {
    familyId: FAM,
    me: ME,
    role: 'member',
    membership: { _id: ME, displayName: 'Dhanya' },
    family: { _id: FAM, timezone: 'Asia/Kolkata' },
  };

  try {
    mockUserFind(users, restorers);
    patchMethod(Notification, 'findOneAndUpdate', async () => null, restorers);
    patchMethod(Notification, 'create', async (doc) => {
      notifications.push(doc);
      return doc;
    }, restorers);
    patchMethod(Membership, 'find', (filter) => {
      const list = members.filter((m) => (!filter._id?.$ne || String(m._id) !== String(filter._id.$ne)));
      return {
        sort: async () => list,
        select: () => ({ lean: async () => list }),
      };
    }, restorers);
    patchMethod(GroceryItem, 'findOne', async () => null, restorers);
    patchMethod(GroceryItem, 'create', async (doc) => ({ _id: 'g-1', ...doc, imageUrl: '' }), restorers);
    patchMethod(Task, 'create', async (doc) => ({ _id: 't-1', ...doc }), restorers);
    patchMethod(ChatMessage, 'create', async (doc) => doc, restorers);

    const res = await invokeRouter(ai, {
      method: 'POST',
      url: '/apply',
      body: {
        actions: [
          { type: 'add_grocery', title: 'Rice', quantity: '5 kg' },
          { type: 'add_grocery', title: 'Tomato', quantity: '1 kg' },
          { type: 'add_task', title: 'Buy vegetables' },
          { type: 'add_task', title: 'Call plumber', assigneeName: 'Ravi' },
        ],
        notifyInChat: true,
      },
      ctx,
    });

    assert.equal(res.statusCode, 201);
    assert.deepEqual(
      notifications.map((n) => [n.userId, n.type, n.title, n.body]),
      [
        ['u-amma', 'grocery', 'Dhanya 2 സാധനങ്ങൾ ലിസ്റ്റിൽ ചേർത്തു', 'Rice, Tomato'],
        ['u-ravi', 'grocery', 'Dhanya 2 மளிகைப் பொருட்களைச் சேர்த்தார்', 'Rice, Tomato'],
        ['u-amma', 'task', 'Dhanya എല്ലാവർക്കുമായി ഒരു ജോലി ചേർത്തു', 'Buy vegetables'],
        ['u-ravi', 'task', 'Dhanya அனைவருக்கும் ஒரு பணியைச் சேர்த்தார்', 'Buy vegetables'],
        ['u-ravi', 'task', 'Dhanya உங்களுக்கு ஒரு பணியை அளித்தார்', 'Call plumber'],
      ],
    );
  } finally {
    restorers.reverse().forEach((fn) => fn());
  }
});

test('web translateNotificationText translates new notification strings', () => {
  assert.equal(
    translateNotificationText('Dhanya added to grocery list', 'ml'),
    'Dhanya പലചരക്ക് ലിസ്റ്റിൽ ചേർത്തു',
  );
  assert.equal(
    translateNotificationText('Dhanya added 4 grocery items', 'ta'),
    'Dhanya 4 மளிகைப் பொருட்களைச் சேர்த்தார்',
  );
  assert.equal(
    translateNotificationText('Dhanya added a medicine schedule', 'hi'),
    'Dhanya ने दवा शेड्यूल जोड़ा',
  );
  assert.equal(
    translateNotificationText('Dhanya added a task for everyone', 'ml'),
    'Dhanya എല്ലാവർക്കുമായി ഒരു ജോലി ചേർത്തു',
  );
  assert.equal(
    translateNotificationText('Dhanya added to grocery list', 'en'),
    'Dhanya added to grocery list',
  );
  assert.equal(
    translateNotificationText('Task due today: Pay gas', 'ml'),
    'ഇന്ന് ചെയ്യേണ്ട ജോലി: Pay gas',
  );
  assert.equal(
    translateNotificationText('Amma joined the family', 'hi'),
    'Amma परिवार में शामिल हुए',
  );
  assert.equal(
    translateNotificationText('Ravi completed: Mop floor', 'ta'),
    'Ravi முடித்தார்: Mop floor',
  );
  assert.equal(
    translateNotificationText('Milk bought by Dhanya (₹60)', 'ml'),
    'Dhanya Milk വാങ്ങി (₹60)',
  );
  assert.equal(
    translateNotificationText('Hommi AI added 3 items to Grocery (Supermarket)', 'ml'),
    'Hommi AI 3 സാധനങ്ങൾ ലിസ്റ്റിൽ ചേർത്തു (Supermarket)',
  );
});
