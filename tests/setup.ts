import { existsSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

const TEST_DB_PATH = path.join(os.tmpdir(), `not-reels-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = 'test';

function removeDbFiles() {
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(TEST_DB_PATH + ext)) unlinkSync(TEST_DB_PATH + ext);
  }
}

beforeAll(async () => {
  const { closeDb, getDb } = await import('../src/db');
  closeDb();
  removeDbFiles();
  getDb();
  const { ensureDefaultTopics } = await import('../src/lib/topics');
  ensureDefaultTopics();
});

afterAll(async () => {
  const { closeDb } = await import('../src/db');
  closeDb();
  removeDbFiles();
});
