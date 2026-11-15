import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { request } from './helpers';

let hits: string[] = [];
let big: Buffer;
/** A stand-in for Redlib's image proxy: a 3000×2000 PNG, and 404 for anything else. */
const upstream: Server = createServer((req, res) => {
  hits.push(req.url!);
  if (req.url!.startsWith('/preview/pre/big.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(big);
  }
  res.writeHead(404);
  res.end();
});

const saved = { redlib: process.env.REDLIB_URL, cache: process.env.IMAGE_CACHE_DIR };
let base = '';

beforeAll(async () => {
  big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3a6' } }).png().toBuffer();
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  hits = [];
  process.env.REDLIB_URL = base;
  process.env.IMAGE_CACHE_DIR = mkdtempSync(path.join(tmpdir(), 'nr-img-test-'));
});

afterEach(() => {
  for (const [key, value] of [['REDLIB_URL', saved.redlib], ['IMAGE_CACHE_DIR', saved.cache]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('GET /_img/…', () => {
  it('serves a Redlib image shrunk to 1080px as WebP, cached on disk', async () => {
    const res = await request('/_img/preview/pre/big.png?width=3000&s=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    const out = Buffer.from(await res.arrayBuffer());
    expect(await sharp(out).metadata()).toMatchObject({ format: 'webp', width: 1080, height: 720 });
    expect(out.length).toBeLessThan(big.length);
    expect(hits).toEqual(['/preview/pre/big.png?width=3000&s=abc']);
    expect(readdirSync(process.env.IMAGE_CACHE_DIR!).filter((f) => f.endsWith('.webp'))).toHaveLength(1);

    const again = await request('/_img/preview/pre/big.png?width=3000&s=abc');
    expect(Buffer.from(await again.arrayBuffer()).equals(out)).toBe(true);
    expect(hits).toHaveLength(1);
  });

  it('only accepts Redlib image paths', async () => {
    for (const p of ['/_img/r/pics/hot', '/_img/settings', '/_img/vid/abc/1080.mp4']) {
      expect((await request(p)).status, p).toBe(404);
    }
    expect(hits).toEqual([]);
  });

  it('passes a missing image through as 404, uncached', async () => {
    const res = await request('/_img/preview/pre/gone.jpg');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers 503 when REDLIB_URL is unset', async () => {
    delete process.env.REDLIB_URL;
    expect((await request('/_img/preview/pre/big.png')).status).toBe(503);
  });
});
