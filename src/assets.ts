declare const __ASSETS__: { css: string; js: string } | undefined;

/** Inlined CSS and the hashed client bundle path, injected by build.mjs (empty in tests). */
export function assets(): { css: string; js: string } {
  return typeof __ASSETS__ !== 'undefined' ? __ASSETS__ : { css: '', js: '/app.js' };
}
