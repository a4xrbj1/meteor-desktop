// `any` stub for modules that are intentionally NOT installed here — seed workspace-cf82.
//
// - 'electron'         → provided by the CONSUMER app at runtime; must not become a
//                        dep of this package (scaffold/desktop.js imports it statically;
//                        skeleton/ uses guarded require('electron') which is untyped anyway).
// - '@playwright/test' → scaffold/desktop.test.js + scaffold/modules/example/example.test.js
//                        are templates copied into the consumer app; lib/bin/cli.js installs
//                        @playwright/test into the CONSUMER project, never here.
//
// jsconfig.json `paths` redirects those module names here, stopping tsc at the
// module boundary. Type-only; zero runtime effect. Named exports cover the import
// forms actually used (verified by grep); a new named import fails with TS2305,
// which points straight at this file to add it.
declare const _loose: any;
export default _loose;
export const app: any;        // electron
export const dialog: any;     // electron
export const test: any;       // @playwright/test
export const expect: any;     // @playwright/test
export const _electron: any;  // @playwright/test
