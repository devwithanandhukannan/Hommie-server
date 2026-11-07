import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { sanitize } from './lib/sanitize.js';
import { safeEqual } from './lib/crypto.js';
import { h, forbidden } from './lib/errors.js';
import { globalLimiter, csrfProtection } from './middleware/security.js';
import { authenticate, familyContext } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { publicAuth, me } from './routes/auth.js';
import { families } from './routes/families.js';
import { tasks } from './routes/tasks.js';
import { grocery } from './routes/grocery.js';
import { meals, recipes } from './routes/meals.js';
import { bills, instances, loans } from './routes/bills.js';
import { expenses, wallet, reports } from './routes/money.js';
import { documents, attachments } from './routes/documents.js';
import { medicines } from './routes/medicine.js';
import { specialDates, guests, contacts } from './routes/life.js';
import { chat } from './routes/chat.js';
import { ai } from './routes/ai.js';
import { dashboard, overview } from './routes/dashboard.js';
import { calendar } from './routes/calendar.js';
import { runTick } from './jobs/tick.js';
import { isPushEnabled } from './services/push.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.webOrigins.includes(origin)),
    credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Family-Id'], maxAge: 600,
  }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(globalLimiter);
  app.use(express.json({ limit: '100kb', strict: true }));
  app.use(cookieParser());

  // Scheduler webhook (secret header, no cookies): registered before CSRF because it is not browser-driven.
  app.post('/internal/cron/tick', h(async (req, res) => {
    if (!config.cronSecret || !safeEqual(req.get('x-cron-secret') || '', config.cronSecret)) throw forbidden();
    res.json(await runTick());
  }));

  app.use(sanitize);
  app.use(csrfProtection);

  const api = express.Router();
  api.get('/health', (_req, res) => res.json({ ok: true, push: isPushEnabled(), vapidPublicKey: isPushEnabled() ? config.vapid.publicKey : null }));
  api.use('/auth', publicAuth);
  api.use('/me', me);
  api.use('/overview', authenticate, overview);
  api.use('/families', families);

  const scoped = express.Router();
  scoped.use(authenticate, familyContext);
  scoped.use('/dashboard', dashboard);
  scoped.use('/tasks', tasks);
  scoped.use('/grocery', grocery);
  scoped.use('/meals', meals);
  scoped.use('/recipes', recipes);
  scoped.use('/bills', bills);
  scoped.use('/bill-instances', instances);
  scoped.use('/loans', loans);
  scoped.use('/expenses', expenses);
  scoped.use('/wallet', wallet);
  scoped.use('/reports', reports);
  scoped.use('/documents', documents);
  scoped.use('/attachments', attachments);
  scoped.use('/medicines', medicines);
  scoped.use('/special-dates', specialDates);
  scoped.use('/guests', guests);
  scoped.use('/contacts', contacts);
  scoped.use('/chat', chat);
  scoped.use('/ai', ai);
  scoped.use('/calendar', calendar);
  api.use(scoped);

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
