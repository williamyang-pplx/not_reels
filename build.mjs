// Production build: Tailwind CSS (inlined into every page), the client bundle (content-hashed),
// and the server bundled into one ESM file so cold start resolves almost no modules.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/public', { recursive: true });

execFileSync('node_modules/.bin/tailwindcss', ['-i', 'src/styles.css', '-o', 'dist/styles.css', '--minify'], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
const css = readFileSync('dist/styles.css', 'utf8');

const client = await build({
  entryPoints: ['client/app.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020', 'safari15'],
  write: false,
});
const js = client.outputFiles[0].contents;
const jsName = `app.${createHash('sha256').update(js).digest('hex').slice(0, 10)}.js`;
writeFileSync(`dist/public/${jsName}`, js);

await build({
  entryPoints: ['src/server.ts'],
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  external: ['better-sqlite3'],
  jsx: 'automatic',
  jsxImportSource: 'hono/jsx',
  define: { __ASSETS__: JSON.stringify({ css, js: `/${jsName}` }) },
  // CJS deps (rss-parser/xml2js) call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const gz = (await import('node:zlib')).gzipSync;
console.log(`css ${(css.length / 1024).toFixed(1)} KB (${(gz(css).length / 1024).toFixed(1)} KB gz) · ${jsName} ${(js.length / 1024).toFixed(1)} KB (${(gz(js).length / 1024).toFixed(1)} KB gz)`);
