import { serve } from '@hono/node-server';
import { getDb } from './db';
import { ensureDefaultTopics } from './lib/topics';
import { createApp } from './app';

// Open the DB and run migrations before accepting traffic (replaces `prisma migrate deploy`).
getDb();
// Also seeded on every topics read (spec §3); seeding at boot means a fresh DB accepts
// feeds before anything has listed topics.
ensureDefaultTopics();

if (process.argv.includes('--migrate-only')) {
  console.log('[db] migrations applied');
  process.exit(0);
}

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '0.0.0.0';
serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  console.log(`[not-brainrot] listening on http://${hostname}:${info.port}`);
});
