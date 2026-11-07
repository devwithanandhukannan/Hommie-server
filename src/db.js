import mongoose from 'mongoose';
import { config } from './config.js';
import { allModels } from './models/index.js';

export async function connectDb(uri = config.mongoUri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, maxPoolSize: 10 });
  const results = await Promise.allSettled(Object.values(allModels).map((m) => m.init()));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`[db] index setup warning for ${Object.keys(allModels)[i]}: ${r.reason?.message}`);
  });
}
export const disconnectDb = () => mongoose.disconnect();
