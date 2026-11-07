import { config } from './config.js';
import { connectDb } from './db.js';
import { createApp } from './app.js';
import { startInternalCron, runTick } from './jobs/tick.js';

await connectDb();
const app = createApp();
const server = app.listen(config.port, () => console.log(`[api] listening on :${config.port} (${config.isProd ? 'production' : 'development'})`));
if (config.internalCron) {
  startInternalCron();
  runTick().catch((e) => console.error('[tick] startup run failed:', e.message));
}
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
