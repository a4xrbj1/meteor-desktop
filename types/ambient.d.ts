// Ambient type stubs for meteor-desktop — seed workspace-cf82 Phase 0.
//
// Why this exists:
//   jsconfig.json has checkJs:true, but tsc runs in no build/test pipeline — it
//   exists only to make editor IntelliSense trustworthy and to surface real bugs
//   on demand via `npm run checkjs` and the per-edit PostToolUse hook. skeleton/
//   files run inside the generated Electron app where the Meteor bundle and the
//   preload script inject globals at runtime; several JSDoc {TypeRef} names point
//   at classes/typedefs that are not exported (or not imported at the reference
//   site), so tsc reports each as TS2304. Everything here is type-only and has
//   ZERO runtime effect — the runtime provides the real implementations.
//
//   This is a script (no top-level import/export) so its top-level declarations
//   are global. Typed as `any` for Phase 0: resolving the real classes would
//   newly type-check every property access on them and grow the tail; tighten
//   to import()-typedefs in a later phase.

// Renderer/injected runtime globals. skeleton/desktop-hcp.js is a classic script
// injected before meteor.js; preload.js exposes Desktop; Meteor arrives with the
// downloaded bundle.
declare var WebAppLocalServer: any; // `var`: skeleton/desktop-hcp.js:7 assigns it bare
declare const Desktop: any;
declare const Meteor: any;

// Meteor's Package registry probed off window (skeleton/desktop-hcp.js:84-86).
interface Window { Package?: any; }

// JSDoc {TypeRef} names tsc cannot resolve cross-file (unexported classes or
// typedefs referenced outside their defining module).
type MeteorDesktop = any;   // class lib/index.js (unexported; default export is a factory)
type App = any;             // skeleton/app.js
type Log = any;             // winston logger instance (skeleton/loggerManager.js)
type Asset = any;           // module-local ctor, skeleton/modules/autoupdate/assetBundle.js
type AssetBundle = any;     // skeleton/modules/autoupdate/assetBundle.js default export
type AssetManifest = any;   // typedef local to skeleton/modules/autoupdate/assetManifest.js
type SquirrelEvents = any;  // skeleton/squirrel.js JSDoc ref — defined nowhere
type Platform = any;        // electron-builder Platform, JSDoc-only ref (lib/electronBuilder.js)
type desktopSettings = any; // typedef in lib/desktop.js, referenced from lib/electronApp.js
