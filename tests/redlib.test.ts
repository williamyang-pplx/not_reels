import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync } from 'node:zlib';
import { CSP } from '../src/app';
import { rewriteRedlibHtml } from '../src/redlib';
import { request } from './helpers';

const REDLIB_CSP = "default-src 'none'; script-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'";
const PAGE = `<html><body><a href="/">redlib</a> <a href="https://example.com/article">link</a>${'<p>post</p>'.repeat(200)}</body></html>`;
const IMAGE = Buffer.alloc(1024 * 1024, 7);

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A stand-in for the Redlib container: records each request and answers by path. */
let seen: Seen[] = [];
const upstream: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url === '/settings' && req.method === 'POST') {
      res.writeHead(302, { Location: '/settings', 'Set-Cookie': ['theme=black; Path=/', 'layout=card; Path=/'] });
      return res.end();
    }
    if (req.url === '/style.css') {
      res.writeHead(304);
      return res.end();
    }
    if (req.url?.startsWith('/img/')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(IMAGE);
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': REDLIB_CSP,
      'X-Frame-Options': 'DENY',
      'Strict-Transport-Security': 'max-age=604800',
    });
    res.end(PAGE);
  });
});

const savedRedlibUrl = process.env.REDLIB_URL;
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  process.env.REDLIB_URL = base;
});

afterEach(() => {
  if (savedRedlibUrl === undefined) delete process.env.REDLIB_URL;
  else process.env.REDLIB_URL = savedRedlibUrl;
  vi.restoreAllMocks();
});

describe('redlibProxy', () => {
  it('serves a Redlib page that our own pages may frame', async () => {
    const res = await request('/r/x/hot?after=t3_a');
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(['/r/x/hot?after=t3_a']);
    expect(seen[0].headers['accept-encoding']).toBe('identity');
    expect(res.headers.get('X-Frame-Options')).toBeNull();
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
    const csp = res.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(csp).not.toBe(CSP);
    const body = await res.text();
    expect(body).toContain('<a href="/r/x">redlib</a>');
    expect(body).toContain('<a target="_blank" rel="noopener" href="https://example.com/article">');
  });

  it('forwards form posts, and passes redirects and every cookie back', async () => {
    const res = await request('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'theme=dark' },
      body: 'theme=black&layout=card',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/settings');
    expect(res.headers.getSetCookie()).toEqual(['theme=black; Path=/', 'layout=card; Path=/']);
    expect(seen[0]).toMatchObject({ method: 'POST', body: 'theme=black&layout=card' });
    expect(seen[0].headers.cookie).toBe('theme=dark');
  });

  it('passes media through byte for byte, forwarding Range', async () => {
    const res = await request('/img/a.jpg', { headers: { Range: 'bytes=0-' } });
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer()).equals(IMAGE)).toBe(true);
    expect(seen[0].headers.range).toBe('bytes=0-');
  });

  it('passes a 304 back without a body', async () => {
    const res = await request('/style.css', { headers: { 'If-None-Match': '"v1"' } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('compresses Redlib HTML like our own pages', async () => {
    const res = await request('/r/x', { headers: { 'Accept-Encoding': 'br' } });
    expect(res.headers.get('Content-Encoding')).toBe('br');
    expect(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toContain('<p>post</p>');
  });

  it('never sends our own paths to Redlib', async () => {
    for (const path of ['/', '/manifest.json', '/saved', '/manage', '/api/topics', '/_f/items?sort=new']) await request(path);
    expect(seen).toEqual([]);
  });

  it('answers 503 when REDLIB_URL is unset', async () => {
    delete process.env.REDLIB_URL;
    const res = await request('/r/x');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers 502 when Redlib is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.REDLIB_URL = 'http://127.0.0.1:9';
    const res = await request('/r/x');
    expect(res.status).toBe(502);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('rewriteRedlibHtml', () => {
  it('opens off-site links in a new tab and leaves Redlib links alone', () => {
    expect(rewriteRedlibHtml(`<a class="x" href='https://ex.com'>`, '/r/x')).toBe(`<a target="_blank" rel="noopener" class="x" href='https://ex.com'>`);
    expect(rewriteRedlibHtml('<a href="http://ex.com" rel="nofollow">', '/r/x')).toBe('<a target="_blank" href="http://ex.com" rel="nofollow">');
    expect(rewriteRedlibHtml('<a href="https://ex.com" target="_self">', '/r/x')).toBe('<a href="https://ex.com" target="_self">');
    expect(rewriteRedlibHtml('<a href="/r/x/comments/abc12/t">', '/r/x')).toBe('<a href="/r/x/comments/abc12/t">');
  });

  it('points the logo link at the page subreddit, or r/popular', () => {
    expect(rewriteRedlibHtml('<a id="redlib" href="/">', '/r/x/comments/1/a')).toBe('<a id="redlib" href="/r/x">');
    expect(rewriteRedlibHtml("<a href='/'>", '/settings')).toBe("<a href='/r/popular'>");
  });
});
