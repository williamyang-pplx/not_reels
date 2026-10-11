import { serve } from '@hono/node-server';
import { getDb } from './db';
import { createApp } from './app';

// Open the DB and run migrations before accepting traffic (replaces `prisma migrate deploy`).
getDb();

if (process.argv.includes('--migrate-only')) {
  console.log('[db] migrations applied');
  process.exit(0);
}

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '0.0.0.0';
serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  console.log(`[not-reels] listening on http://${hostname}:${info.port}`);
});
