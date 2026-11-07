// Prints every secret you need for production. Run: npm run secrets -w apps/api
import crypto from 'node:crypto';
import webpush from 'web-push';

const vapid = webpush.generateVAPIDKeys();
const hex = (n) => crypto.randomBytes(n).toString('hex');
console.log(`# Paste these into Render -> familyhub-api -> Environment. Keep them private. Do not commit.
JWT_ACCESS_SECRET=${hex(48)}
DOC_MASTER_KEY=${hex(32)}
CRON_SECRET=${hex(24)}
VAPID_PUBLIC_KEY=${vapid.publicKey}
VAPID_PRIVATE_KEY=${vapid.privateKey}
VAPID_SUBJECT=mailto:you@example.com
`);
console.log('# WARNING: if you ever lose DOC_MASTER_KEY, uploaded documents can no longer be decrypted. Back it up in a password manager.');
