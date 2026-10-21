interface Assets {
  css: string;
  js: string;
  build: string;
}
declare const __ASSETS__: Assets | undefined;

/** Inlined CSS, the hashed client bundle path and a build id for both, injected by build.mjs (empty in tests). */
export function assets(): Assets {
  return typeof __ASSETS__ !== 'undefined' ? __ASSETS__ : { css: '', js: '/app.js', build: 'dev' };
}
