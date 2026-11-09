const e = process.env;
const isProd = e.NODE_ENV === 'production';
const isTest = e.NODE_ENV === 'test';

function need(name, devDefault) {
  const v = e[name];
  if (v) return v;
  if (!isProd && devDefault !== undefined) return devDefault;
  throw new Error(`Missing required environment variable: ${name}`);
}

const jwtSecret = need('JWT_ACCESS_SECRET', 'dev-only-secret-do-not-use-in-production-0123456789');
const masterKeyHex = need('DOC_MASTER_KEY', 'a'.repeat(64));

if (isProd) {
  if (jwtSecret.length < 32) throw new Error('JWT_ACCESS_SECRET must be at least 32 characters');
  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
    throw new Error('DOC_MASTER_KEY must be 64 hex characters (32 bytes)');
  }
}

export const config = {
  isProd,
  isTest,
  port: Number(e.PORT || 4000),
  mongoUri: need('MONGODB_URI', 'mongodb://127.0.0.1:27018/familyhub'),
  jwtSecret,
  masterKeyHex,
  webOrigins: (e.WEB_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  webOrigin: (e.WEB_ORIGIN || 'http://localhost:3000').split(',')[0].trim().replace(/\/$/, ''),
  trustProxy: Number(e.TRUST_PROXY ?? 1),
  cronSecret: e.CRON_SECRET || '',
  internalCron: (e.INTERNAL_CRON ?? 'true') !== 'false',
  vapid: {
    publicKey: e.VAPID_PUBLIC_KEY || '',
    privateKey: e.VAPID_PRIVATE_KEY || '',
    subject: e.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
  smtp: {
    host: e.SMTP_HOST || 'smtp.gmail.com',
    port: Number(e.SMTP_PORT || 465),
    secure: (e.SMTP_SECURE ?? 'true') !== 'false',
    user: e.SMTP_USER || '',
    pass: (e.SMTP_PASS || '').replace(/\s+/g, ''),
    from: e.EMAIL_FROM || (e.SMTP_USER ? `"Hommi" <${e.SMTP_USER}>` : '"Hommi" <workbridge.anandhu@gmail.com>'),
  },
  bcryptCost: isTest ? 4 : 12,
  accessTtl: '15m',
  refreshDays: 30,
  maxDocBytes: 4 * 1024 * 1024,
  familyDocQuotaBytes: 80 * 1024 * 1024,
  defaultTimezone: e.DEFAULT_TIMEZONE || 'Asia/Kolkata',
  geminiApiKey: e.GEMINI_API_KEY || '',
};
