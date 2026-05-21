## v6.0.10 <sup>21.05.2026</sup>

Maintenance release refreshing all transitive and direct npm dependencies to their latest versions. No production code changes; the full unit suite (193 tests) passes against the bumped tree.

### Maintenance

* **Refresh direct dependencies to latest minors/patches and five major bumps.** Within-major: `@babel/preset-env` 7.29.2 → 7.29.5 (pinned), `@babel/register` 7.28.6 → 7.29.3 (pinned), `eslint` 10.0.3 → 10.4.0, `fs-extra` 11.3.4 → 11.3.5 (pinned), `globals` 17.4.0 → 17.6.0, `semver` 7.7.4 → 7.8.0, `terser` 5.46.1 → 5.47.1, `sinon` 21.0.3 → 21.1.2 (then to 22.0.0 below), `@electron/packager` 19.1.0 → 19.1.1. Major bumps verified safe against this repo by import-trace plus full test run: `@electron/packager` 19 → 20 (no direct imports — the active electron-packager comes from `lib/defaultDependencies.js` and is fetched per-project at runtime), `babel-plugin-istanbul` 7 → 8 (nyc coverage instrumentation; suite still green), `cacache` 20 → 21 (no direct imports anywhere in the repo), `sinon` 21 → 22 (active in tests; full suite passes), `typescript` 5 → 6 (no `.ts` files, no `tsconfig*`, no `typescript` imports). `package-lock.json` rewritten by `npm install` after the bumps.

## v6.0.9 <sup>21.05.2026</sup>

Patch release closing the residual `app/`-prefix gap in `injectEsm`'s chunk scraper, ensuring the chunk-scraper inner catch rethrows the A2.7 gate error instead of swallowing it, and validating `Content-Type` on every network-fetched chunk to prevent the Meteor dev server's HTML SPA-error page from being silently written under a `.css`/`.js` path.

### Bug Fixes

* **Probe `meteorAppDir/app/<rel>` in `injectEsm`'s chunk-scraper guard.** The outer existence check at the scraper write block now skips the write when the chunk is already present at its `app/`-relative location, complementing the URL-set check added in v6.0.8. The two mechanisms together guarantee no redundant root-level copy regardless of how the file reached `app/`: `bundledManifestUrls` covers manifest-registered URLs (the typical case), and the disk probe covers the orphan-bundled case admitted by the chunksRefs validator at `lib/meteorApp.js:1683-1685` but not previously enforced at the scraper.
* **Fall back to `app/<rel>` in `injectEsm`'s manifest re-write loop.** When a chunksRefs URL is missing from `program.json` and the scraper skips its write because the `app/`-relative copy already exists, the manifest re-write loop now probes the `app/<rel>` candidate after the root-level check and registers the entry with its authoritative path. Without this co-change the URL would be left out of the manifest entirely and A3.5 Check 1 would throw "index.html references N asset(s) not in program.json manifest" for the same orphan-bundled case.
* **Resolve A3.5 Check 4 CSS validations through the manifest's authoritative path.** The CSS content-type validator in `validateManifestAssetCoherence()` previously looked the asar file up by the root-level URL path and silently returned early ("Already caught by Check 2") whenever the asset was bundled under `app/`. Check 4 now reads `manifestByUrl.get(hrefPath).path` and inspects the file at that location, restoring the integrity check for every `app/`-bundled `build-chunks*` CSS.
* **Rethrow A2.7 gate errors from `injectEsm`'s chunk-scraper inner catch.** The outer `try { … } catch (e) { this.log.error(`injectEsm: Rspack asset bundling failed: ${e.message}`); }` around the chunk-scraper block previously swallowed the A2.7 throw, downgrading a build-fatal "rspack asset … missing from build after scraper pass. HCP will fail." into a logged warning, after which the build proceeded to pack a broken `meteor.asar`. The inner catch now re-throws so the A2.7 gate aborts the build at the right layer.
* **Validate `Content-Type` on network-fetched chunks in `injectEsm`'s scraper (seed `meteor-desktop-4a0d`).** Meteor's dev server returns HTTP 200 + `text/html` (a SPA error page) for any path it does not serve. The network-fetch branch of the chunk scraper previously trusted `res.ok` alone, so that HTML body was written to disk under the requested `.css`/`.js` URL and was only caught post-hoc by A3.5 Check 4's magic-byte scan after the asar was already packed. After `res.ok`, the scraper now inspects `res.headers.get('content-type')` and requires it to include `'css'` for `.css` URLs or `'javascript'` for `.js` URLs; on mismatch it warns (with URL + observed content-type), skips the write, and continues to the next port. If both ports return a non-matching content-type, the chunk is still missing from disk and the A2.7 gate throws a precise "asset missing" error — the correct loud failure mode in place of the previous silent contamination. The two mechanisms are intentional and disjoint: the new pre-flight `Content-Type` check protects the network ingress with the upstream's declared type, while A3.5 Check 4 remains the post-write magic-byte safety net for any future non-network path that bypasses the new guard.

### Tests

* `tests/unit/meteorApp.test.js` — five new cases under `#injectEsm chunk scraper`. (a) The scraper skips the redundant root-level write when only the `app/` copy exists (fixture stages a stale `_build/main-prod/build-chunks-local-desktop/main.css` so the test actually exercises the new guard rather than passing because the network fallback failed silently). (b) The manifest gains an entry pointing at the authoritative `app/<rel>` path when the URL was missing from `program.json`. (c) The A2.7 gate throws past the inner catch when a discovered rspack chunk has no on-disk file and is absent from the manifest. (d) The network-fetch branch rejects a response whose `Content-Type` does not match the URL extension — HTML returned at HTTP 200 for a `.js` URL is not written to disk and A2.7 fires for the still-missing asset. (e) The network-fetch branch writes the buffer when the response `Content-Type` matches. Inversion checks (Rule 44): reverting any one of the new guards fails the corresponding test.

## v6.0.8 <sup>19.05.2026</sup>

Patch release fixing the `injectEsm` build abort on Meteor 3.x apps whose rspack stylesheet `<link>` tags reference the extracted main CSS by an unhashed, web-root URL while the asset is content-hashed under `app/`.

### Bug Fixes

* **Resolve content-hashed rspack CSS `<link>` assets in the A2.5 hash-coherence gate and `injectEsm`.** `@meteorjs/rspack` content-hashes the extracted main CSS and places it under `app/` (e.g. `app/build-chunks-local-desktop/main.<hash>.css`), but Meteor's generated `head.html` — and `injectEsm`'s own chunk scraper, reading rspack's `index.html` — reference it unhashed at the web root (`/build-chunks-local-desktop/main.css`). The desktop runtime `AssetHandler` resolves assets by exact `program.json` manifest URL, so an unhashed href is unserveable; `injectEsm`'s `<link>` validator only probed two literal disk paths, never the manifest, and aborted the build with `injectEsm: … script/link asset(s) missing on disk after A2.5 hash coherence gate`. `validateHashCoherence()` (A2.5) now rewrites every unhashed rspack `<link rel="stylesheet">` href to its content-hashed manifest URL and prunes a stylesheet link that has no bundled asset at all (a foreign non-desktop build-context artifact such as a stray `/build-chunks-local/main.css`); it throws if *every* stylesheet is unresolvable rather than packaging a style-less build. `injectEsm` applies the same resolution to the CSS URLs it scrapes from rspack's `index.html` — A2.5 alone is insufficient because `injectEsm`'s step 2.5 injects its own `<link>` *after* A2.5 has run.
* **Skip manifest-resident assets in `injectEsm`'s chunk scraper and the A2.7 gateway check.** Assets already listed in `program.json` are bundled under `app/` and served by the runtime `AssetHandler`. The scraper previously treated their `app/`-relative location as "missing", created empty `build-chunks-*/` directories, and the A2.7 gate raised a false `A2.7: rspack asset … missing from build`. Both now skip any chunk URL present in the manifest (or resolvable under `app/`), and unhashed CSS chunk URLs are resolved to their hashed manifest counterpart before the scraper, the A2.7 gate and the injected `<link>` tag consume them.

### Tests

* `tests/unit/meteorApp.test.js` — four new cases under `#validateHashCoherence stylesheet links`: the unhashed→hashed rewrite, pruning a foreign-context stylesheet link, the all-stylesheets-unresolvable safety throw, and leaving non-stylesheet `<link>` tags (favicons) untouched.

## v6.0.7 <sup>14.05.2026</sup>

Patch release making the rspack build-context, chunks-context and assets-context paths dynamic so meteor-desktop tracks `@meteorjs/rspack@^2.x`'s `METEOR_LOCAL_DIR`-derived output directories. Closes the silent-fallthrough failure mode that v5.1.6 / v5.1.7 / v6.0.6 partially patched: prod desktop builds wrote rspack output to `_build-local-desktop/main-prod/` while `injectEsm()` still looked under `_build/main-prod/` and shipped the 945-byte HMR placeholder as the client bundle.

### Bug Fixes

* **Resolve `injectEsm`'s rspack bundle directory dynamically.** Prior versions hardcoded `_build/main-prod/` and `_build/main-dev/`. Under `@meteorjs/rspack@^2.x` the directory name is derived from `path.basename(METEOR_LOCAL_DIR)` (`rspack.config.js:247-261`) — production desktop builds emit to `_build-local-desktop/main-prod/`. `lib/env.js` now mirrors that algorithm and exposes `paths.meteorApp.rspack.{buildContext,chunksContext,assetsContext,buildDir}`. `injectEsm()` probes the v2.x-derived path AND the v1.x fallback `_build/` (first-found-wins); when neither resolves to a real `client-rspack.js`, the function throws with the candidate path list and the actionable `RSPACK_BUILD_CONTEXT` escape hatch instead of silently shipping a broken bundle.
* **Match `build-chunks-<suffix>/` and `build-assets-<suffix>/` URLs in the chunk scraper, the A3.5 CSS gate and the runtime protocol-handler whitelist.** A single shared regex (`/\/build-(?:chunks|assets)(?:-[^/]+)?\//`) admits the v1.x default names AND any `METEOR_LOCAL_DIR`-derived suffix (`-local`, `-local-desktop`, …). Retires v6.0.6's `(?:-local)?` special case, which only covered the dev-mode basename and silently missed every `-local-desktop` URL in prod desktop builds.
* **Inject the `<script src="/__rspack__/client-rspack.js">` tag in dev-mode HTML that uses suffixed chunk URLs.** `skeleton/app.js#injectRspackClientScript` previously gated on a literal `/build-chunks/` substring and silently no-op'd when the dev server emitted only `/build-chunks-local/` or `/build-chunks-local-desktop/` URLs. The new dynamic-suffix regex restores rspack-client-script injection across every emitted URL shape.
* **Clean every candidate `_build*` directory at the start of a production build.** `build()`'s rspack-artifact wipe now iterates the candidate context list (v2.x-derived AND v1.x `_build/`), preserving the v6.0.2 dev-server safety check on each. A leftover `_build/` from a prior v1.x build no longer orphans across the v1→v2 transition.

### Tests

* `tests/unit/env.test.js` — four new cases covering the prod `METEOR_LOCAL_DIR`-derived defaults, the dev-mode `.meteor/local` fallback basename, the `RSPACK_BUILD_CONTEXT` env-var override, and an inherited `METEOR_LOCAL_DIR` overriding the dev-mode default.
* `tests/unit/skeleton/app.test.js` — one new case asserting `injectRspackClientScript` rewrites HTML whose only chunk URL is `/build-chunks-local-desktop/main.css`.

## v6.0.6 <sup>12.05.2026</sup>

Patch release extending the build-time asset URL scraper to recognise `@meteorjs/rspack@^2.0.1`'s new `/build-chunks-local/*` URL prefix, completing the dev/build parity introduced in v6.0.5.

### Bug Fixes

* **Scrape `/build-chunks-local/*` asset URLs from `combinedHtmlForScraping`.** `@meteorjs/rspack@^2.0.1` emits its dynamic chunks under both `/build-chunks/*` and `/build-chunks-local/*`, and the v6.0.5 protocol-handler whitelist made the runtime side route both prefixes correctly. The build-time scraper in `meteorApp.js#scrapeAndCacheAssets` was still matching only `/build-chunks/` (no `-local` variant), so production desktop builds against a Meteor 3.4.1 / `@meteorjs/rspack@^2.0.1` app silently skipped every `-local` URL in the scraped `index.html` and aborted with `build-chunks-local/main.css missing` once `acquireIndex()` tried to package the index. The regex at `lib/meteorApp.js:1509` now matches `/build-chunks(?:-local)?/` (and continues to match `/__rspack__/`), restoring full asset coverage across both prefix variants for the desktop production build pipeline.

## v6.0.5 <sup>12.05.2026</sup>

Patch release adding dev-mode compatibility for consumer apps on Meteor 3.4.x with `@meteorjs/rspack@^2.0.1` + `@rspack/dev-server@^2.0.1`, plus a fix for hot code push detected after the initial window load.

### Bug Fixes

* **Neutralize rspack-dev-server live-reload at the source.** Under `@meteorjs/rspack@^2.0.1` the Electron renderer entered a continuous reload loop after any frontend file change (~700ms cycle, full DDP-reconnect storm, 100% renderer CPU). Diagnostic instrumentation confirmed Meteor's `Reload._reload` was never invoked and no JavaScript-level navigation API (`location.reload` / `replace` / `assign` / `href` setter) was called; the loop ran entirely through the rspack-dev-server client's `reloadApp()` calling `rootWindow.location.reload()` and `self.location.reload()` directly. Those hit `window.location`'s own non-configurable methods (WebIDL `[LegacyUnforgeable]`), so no `Location.prototype` shim or `executeJavaScript` override could intercept them — the call sites had to be patched in the source bundle. The protocol-handler's JS-proxy block in `app.js` now regex-replaces the two `location.reload()` call sites inside `/__rspack__/client-rspack.js` with `console.warn(…)`; the dev server still rebuilds, the renderer just ignores its "please reload" signal. (`Rule 32` retired three obsolete `var allowToHot` / `var allowToLiveReload` / `var maxRetries = 10` regex patches that targeted webpack-dev-server-1.x identifiers no longer present in the modern rspack-dev-server client. A `warnOnce` canary now fires loudly if the new patches stop matching, so the next upstream client change is caught immediately rather than silently regressing into another reload loop.)
* **Route `/build-chunks-local/*` and `/build-assets-local/*` through the rspack asset whitelist.** `@meteorjs/rspack@^2.0.1` emits dynamic chunks under `/build-chunks-local/` and the Meteor dev server 307-redirects those to `/__rspack__/build-chunks-local/`. Without the whitelist additions in `isRspackAssetRequest`, the protocol handler routed the requests through `/__browser/` and fell through to the Meteor SPA HTML fallback, returning `<!DOCTYPE html>...` for what the renderer expected as JavaScript. The result was `Uncaught SyntaxError: Unexpected token '<'` and a `ChunkLoadError` white-screen on the first dynamic import (e.g. an electron-main route). Both `-local` suffix variants are now whitelisted so Electron's `net.fetch` follows the redirect transparently to the actual chunk bytes.
* **Relax the A3.5 manifest-asset coherence gate's CSS check in dev mode.** Same situation as the existing `__rspack__/client-rspack.js` placeholder tolerance 30 lines above: under `@meteorjs/rspack@^2.0.1` the bytes for `/build-chunks/*.css` live on the rspack dev server at runtime, not in the packaged asar. The Meteor dev server returns its SPA HTML fallback when `meteorApp.acquireIndex()` fetches those CSS paths, so the gate (correctly detecting non-CSS content) used to block every dev startup. The check now demotes to a `log.warn` when `skipMobileBuild=true`; PROD remains strict where the CSS must be a real bundled asset.
* **Reset `meteorAppVersionChange` and handle post-initial-load HCP in `handleAppStartup`.** Two related fixes to the HCP reset path: (a) the flag is now cleared on the first-load HCP branch immediately, preventing subsequent `did-stop-loading` events from re-entering `updateToNewVersion()` and double-resetting the local server; (b) the `windowAlreadyLoaded` branch now performs the same HCP reset when `meteorAppVersionChange` becomes true *after* the initial load, instead of silently logging `window already loaded`. A new HCP bundle that becomes ready post-load is now honoured exactly the same way as one ready pre-load.

## v6.0.4 <sup>04.05.2026</sup>

Patch release fixing two issues that together caused production desktop builds on Meteor 3.x apps to silently pack Meteor's "App Error" page instead of the real index.html.

### Bug Fixes

* **Set `NODE_ENV=production` when spawning Meteor for a production build:** `buildMobileTarget()` previously spawned `meteor run --verbose --production -p 3080` without setting `NODE_ENV`. The `--production` flag flips minification but does not change `Meteor.isDevelopment`, so the atmosphere `rspack@1.0.0` plugin's `isMeteorAppDevelopment()` returned `true` and resolved `meteor.mainModule` entrypoints to `_build/main-dev/{client,server}-meteor.js` — the dev paths. With `_build/main-dev/server-meteor.js` missing (because the production rspack run only writes to `_build/main-prod/`), Meteor served its error page from port 3080. `acquireIndex()` then fetched the error HTML and the build proceeded with garbage. The spawn env now adds `NODE_ENV=production` whenever `isProductionBuild()` is true, so the rspack plugin treats the build as production and writes the right entrypoints.
* **Refuse to pack Meteor's error page in `acquireIndex()`:** when the response from the running Meteor server contains `<title>Meteor App - Error</title>`, `acquireIndex()` now extracts the `<code class="log-content">` block, decodes the Meteor error message, and throws with the real Meteor error included. Previously the error HTML flowed through `injectEsm` (whose `replace(/<script/i, …)` silently no-op'd because the error page has no `<script>` tag), got packed into `meteor.asar`, and surfaced two gates later as a misleading "A3: index.html missing setImmediate polyfill — injectEsm did not run or was skipped". The new guard fails at the right layer with the actual upstream Meteor error.

## v6.0.3 <sup>04.05.2026</sup>

Patch release stopping `checkPreconditions()` from auto-adding an iOS Cordova platform on Meteor 3.x desktop-only builds.

### Bug Fix

* **Gate the `.meteor/platforms` auto-add on `INDEX_FROM_LOCAL_BUILD`:** `checkPreconditions()` previously added `ios` to `.meteor/platforms` for every production build (`!skipMobileBuild`) that lacked both `ios` and `android`. The auto-add dates from the legacy `INDEX_FROM_LOCAL_BUILD` strategy (Meteor < 1.3.4.2), where the Electron client bundle came from `web.cordova` and a Cordova platform was actually required. Under the modern `INDEX_FROM_RUNNING_SERVER` strategy (Meteor ≥ 1.3.4.2), `copyBuild()` reads `web.browser` and downloads `index.html` from the spawned `meteor run --production` — no Cordova platform is ever consulted. The auto-add was dead-but-active code that on macOS triggered a `cordova-ios@7.1.1` install plus a CocoaPods prerequisite check that failed builds for desktop-only apps. The block is now gated on `this.indexHTMLstrategy === this.indexHTMLStrategies.INDEX_FROM_LOCAL_BUILD`, preserving legacy behavior while no-op'ing for Meteor 3.x.

### Tests

* Added `#checkPreconditions mobile platform auto-add` describe block in `tests/unit/meteorApp.test.js` covering both strategies: asserts no `addMobilePlatform` call and an unchanged `.meteor/platforms` file under `INDEX_FROM_RUNNING_SERVER`, and a single `addMobilePlatform('ios')` call under `INDEX_FROM_LOCAL_BUILD`.

## v6.0.2 <sup>03.05.2026</sup>

Patch release adding a fast-fail guard so production builds refuse to wipe a `_build/` directory still owned by a parallel Meteor dev server.

### Bug Fix

* **Refuse `_build/` wipe when dev-server rspack artifacts are present:** `build()` previously deleted `_build/` unconditionally for production runs. If a `meteor run` (e.g. `npm run start`) was running in another terminal, the wipe destroyed `_build/main-dev/{server,client}-meteor.js` and `_build/test/{server,client}-meteor.js`, sending the dev server into a `Could not resolve meteor.mainModule "_build/main-dev/server-meteor.js"` restart loop. The cleanup now scans for those four artifacts up-front and aborts with `process.exit(1)` and an actionable message if any are found, rather than silently corrupting the parallel session.

## v6.0.1 <sup>30.04.2026</sup>

Version-only bump.

## v6.0.0 <sup>15.04.2026</sup>

### BREAKING CHANGES

* **Removed desktopHCP** (`.desktop` hot code push). The `desktopHCP`, `desktopHCPIgnoreCompatibilityVersion`, and `desktopHCPCompatibilityVersion` settings are no longer recognized. The `plugins/watcher` and `plugins/bundler` Meteor build plugins have been removed. Meteor's standard web.browser HCP continues to work as before. If you need desktopHCP support, fork [v5.1.7](https://github.com/a4xrbj1/meteor-desktop/tree/v5.1.7).

### Removed

* `plugins/watcher/` — Meteor build plugin that watched `.desktop` for changes
* `plugins/bundler/` — Meteor build plugin that created `desktop.asar` bundles
* `ensureDesktopHCPPackages()` — build-time symlink orchestration for the above plugins
* `getDesktopVersion()` — runtime desktop manifest fetcher in autoupdate module
* `handleDesktopBundle()` — runtime desktop bundle copy/write logic
* `loadDesktopVersion()` / `writeDesktopVersion()` — asset bundle desktop version I/O
* `readDesktopVersionInfoFromBundle()` — desktop path resolver helper
* Desktop version resolution logic in `desktopPathResolver.js` — always uses embedded `desktop.asar` now
* `--hcp` relaunch path in `app.js` — no longer needed without desktop bundle updates
* `desktopHCP*` settings from scaffold `settings.json` template
* desktopHCP test suite and `version.desktop.json` test server endpoint

### Simplified

* `resolveDesktopPath()` always returns the embedded `desktop.asar` path
* `shouldDownloadBundleForManifest()` no longer checks desktop compatibility version
* `checkForUpdates()` always proceeds to fetch web manifest (no `desktopHCP` gate)
* A2.5 / injectEsm validation skip sets reduced to `mongo-dev-server.js` only

## v5.1.7 <sup>15.04.2026</sup>

Patch release fixing three build failures in dev mode (`skipMobileBuild`) and hardening validation gates for rspack-based Meteor 3.x projects.

### Bug Fixes

* **Fixed `_build/` deletion crashing running dev server:** `build()` unconditionally deleted the `_build/` directory, destroying the rspack entry points (`_build/main-dev/server-meteor.js`) used by the running Meteor dev server. This caused a cascade: the dev server entered error state, `copyBuild()` got corrupt web.browser output, and the A3 setImmediate polyfill injection silently failed. The cleanup is now gated on `!skipMobileBuild` so it only runs for production builds where `buildMobileTarget()` regenerates it.
* **Fixed rspack main bundle missing from `program.json` manifest:** The `/__rspack__/client-rspack.js` script tag was injected *after* HTML scraping built `chunksRefs`, so it was never added to the manifest. The A3.5 manifest-asset coherence gate correctly caught this. The main bundle URL is now explicitly included in the manifest update loop.
* **Fixed false-positive A3.5 failure on favicon `<link>` tags:** The manifest coverage check scraped all `<link href>` tags, including `rel="shortcut icon"` and `rel="apple-touch-icon"`. These static assets do not need manifest entries. The check now only validates `<link rel="stylesheet">` tags.

### Validation Improvements

* **A3.5 rspack placeholder check is now dev-mode aware:** In `skipMobileBuild` mode, the HMR placeholder in `__rspack__/client-rspack.js` is expected — the real bundle is served by the rspack dev server at runtime. The check now logs a warning instead of throwing in dev mode, while still blocking production builds with stale placeholders.

### CI & Tests

* Repaired 5 failing unit tests: Env tests updated for hardcoded `.meteor/local-desktop` vs `.meteor/local` paths; meteorApp tests fixed for sinon stub encoding mismatch (`'UTF-8'` vs `'utf8'`).
* Upgraded CI actions: `checkout` v4→v6, `setup-node` v4→v6, `cache` v4→v5 to resolve Node.js 20 runner deprecation warnings. Pinned node to 22.22.0.

## v5.1.6 <sup>15.04.2026</sup>

Patch release preventing stale rspack dev artifacts from breaking production builds and adding a new build validation gate.

### Bug Fix

* **Fixed stale rspack build contamination:** `injectEsm()` previously iterated `['main-dev', 'main-prod']` and picked the first match. If a stale `_build/main-dev/` directory existed from a prior dev session, the 945-byte HMR placeholder was used instead of the production rspack bundle, shipping broken macOS builds with empty UI code and `Unexpected token '<'` errors.
* **`_build/` cleanup at build start:** The `_build/` directory is now deleted at the beginning of `build()` before Meteor runs, ensuring no stale dev rspack artifacts can contaminate the production build.
* **Reversed rspack build type priority:** `injectEsm()` now iterates `['main-prod', 'main-dev']`, always preferring the production rspack output as defense-in-depth.

### New Validation Gate

* **A3.5 Manifest-Asset Coherence:** New build-blocking validation gate that runs after `packToAsar` and checks the packed `meteor.asar` for:
  1. Every `<script src>` and `<link href>` in `index.html` is resolvable via the `program.json` manifest (preventing runtime `AssetHandler` misses that serve HTML instead of JS/CSS).
  2. Every matched manifest entry's `path` field resolves to a real file in the asar.
  3. `__rspack__/client-rspack.js` is not a dev HMR placeholder (must be >10KB).
  4. CSS files in `build-chunks/` contain actual CSS content, not HTML.

### Documentation

* **Documented HCP limitations with rspack builds:** Added prominent warnings in README explaining that Desktop HCP cannot update rspack-bundled code and recommending `"desktopHCP": false` for rspack-based Meteor 3.x projects.

## v5.1.5 <sup>01.04.2026</sup>

Patch release fixing a regression in dev mode introduced by the v5.1.4 build isolation change.

### Bug Fix

* Only redirect to `.meteor/local-desktop` when meteor-desktop builds Meteor itself (production/package builds). In dev mode (`skipMobileBuild`), Meteor runs externally and writes to the default `.meteor/local/` — the v5.1.4 change unconditionally redirected to `.meteor/local-desktop/` which doesn't exist in dev, breaking `npm run desktop`.

## v5.1.4 <sup>31.03.2026</sup>

Patch release with an isolated build directory for desktop builds and dependency updates.

### Build Isolation

* Use a dedicated `.meteor/local-desktop` directory for desktop/Electron builds instead of the shared `.meteor/local`, preventing race conditions when a dev server runs concurrently with a production build.

### Dependency Updates

* `@babel/preset-env` 7.29.0 → 7.29.2
* `@babel/runtime` 7.28.6 → 7.29.2
* `@electron/asar` ^4.1.0 → ^4.1.2
* `@electron/packager` ^19.0.5 → ^19.1.0
* `cacache` ^20.0.3 → ^20.0.4
* `sinon` ^21.0.2 → ^21.0.3
* `terser` ^5.46.0 → ^5.46.1

## v5.1.3 <sup>23.03.2026</sup>

Patch release improving rspack bundling reliability and module compatibility.

### Rspack and Module Fixes

* Recursively patch all JS files for module.link safety and silence HTML template errors that could break Blaze template initialization in the desktop bundle.
* Enhance rspack chunk scraper to use localhost with better priority ordering, and add A2.7 bundling gate to validate rspack assets before packaging.
* Add extension-less asset fallback for integrity validation, preventing false negatives when program.json entries omit file extensions.

## v5.1.2 <sup>20.03.2026</sup>

Patch release expanding regression test coverage.

### Test Coverage Expansion

* Add unit tests for `meteorApp` private helpers: `patchClientBundleJs`,
  `hasResidualClientEsmPatterns`, and `reconcileIndexHtmlScriptsWithManifest`,
  using an ESM-safe temp-module export pattern without touching production exports.
* Add unit test for `Env`: absolute `METEOR_LOCAL_DIR` values are preserved
  as-is (not joined under `meteorApp.root`).
* Add unit test for `App#injectRspackClientScript`: appends the rspack client script
  at the end of the string when no `</body>` tag is present.
* Add unit tests for `App#prepareAutoupdateSettings`: verifies default values and
  per-setting override passthrough (`customHCPUrl`, `webAppStartupTimeout`,
  `initialBundlePath`).
* Add functional test for autoupdate: falls back to the initial bundle when
  `lastKnownGoodVersion` is recorded in `autoupdate.json` but the corresponding
  version directory is missing from disk.

## v5.1.1 <sup>20.03.2026</sup>

Minor stability release focused on Electron dev boot correctness for Meteor 3.x + rspack apps.

### Electron Dev Boot & Routing Fixes

* Fix white-window startup in Electron dev mode by injecting the missing `__rspack__/client-rspack.js` when Cordova HTML includes rspack assets but omits the client bundle script.
* Restore full route registration in `flow-router-extra` during desktop startup (`home`, `sign-in`, discuss routes, etc.) by ensuring the rspack client app actually executes.
* Add focused unit coverage for HTML patching logic in `skeleton/app.js` to prevent regressions in dev-mode script injection.

### Bootstrap/Asset Coherence Hardening

* Preserve and reconcile bootstrap script references against authoritative `program.json` during dev bootstrap handling to avoid stale manifest/script drift.
* Improve embedded bootstrap invalidation behavior so stale persisted autoupdate state is dropped when the initial bootstrap signature changes.
* Add targeted tests for bootstrap signature invalidation and desktop path resolution behavior.

## v5.1.0 <sup>18.03.2026</sup>

Adds full rspack bundler support alongside existing Babel builds, renames plugins to the `@a4xrbj1` namespace, and hardens build validation gates.

### Rspack Bundler Support
* Support Meteor apps bundled with rspack in addition to the traditional Babel pipeline.
* Route `/__rspack__/`, `/build-assets/`, and `/build-chunks/` paths through the Meteor dev server proxy in Electron.
* Resolve rspack-style asset paths (files in `app/` subdirectory) via `program.json` manifest in both A2.5 hash coherence gate and `injectEsm()` validation.
* Normalize stale script src hashes in `index.html` against the authoritative `program.json` manifest.
* Throttle noisy rspack/webpack-dev-server reconnection logs in the Electron console.
* Disable rspack hot-reload and live-reload in the Electron client (not applicable to desktop builds).

### Plugin Namespace Rename
* Rename Atmosphere plugins from `communitypackages:meteor-desktop-*` to `a4xrbj1:meteor-desktop-*`.
* Fix `ensureDesktopHCPPackages()` to write packages to `.meteor/packages` in addition to symlinking (symlinks alone were insufficient).
* Skip HCP build-plugin package script tags in A2.5 and `injectEsm()` validation gates (server-only packages that produce no client JS).

### Dev Proxy Hardening
* Parse `meteor://` request URLs with `URL` constructor instead of substring slicing for correct query string handling.
* Retry fetch on connection error after local server restart.

### Housekeeping
* Remove stale CI configs (`appveyor.yml`, `.coveralls.yml`, `.codeclimate.yml`, `.babelrc`, `.npmignore`), dead `devEnvSetup.js`, and `gh-md-toc`.
* Remove `coveralls` dev dependency.
* Update README: correct package name to `@a4xrbj1/meteor-desktop`, fix Electron link, add maintainer attribution.
* Update test fixtures and helpers for Node 22 and Meteor 3.x compatibility.
* Remove dead `ioHelper` test (source file no longer exists).
* Add `jsconfig.json` with workspace excludes for VS Code.

## v5.0.0 <sup>15.03.2026</sup>

Major release bringing full Meteor 3.x compatibility, ESM support, dependency debloat, and a hardened build pipeline.

### Meteor 3.x Compatibility
* Switch bundler architecture from `web.cordova` to `web.browser` — Meteor 3.x no longer builds a `web.cordova` target for desktop apps.
* Fix `isCordova` detection for Meteor 3.x object-literal form (`isCordova: false`).
* Replace `acquireManifest()` HTTP fetch with `fs.readFileSync` from on-disk build output; add defensive JSON validation.
* Use `/__browser/` manifest and asset paths for Meteor 3.x dev server (was `/__cordova/`).
* Fix autoupdate manifest/version handling for Meteor 3.x `web.browser` arch.
* Fall back to unpacked `meteor/` directory when `meteor.asar` is absent in dev mode.
* Extend `injectEsm()` to patch root-level JS files produced by Meteor 3.x linker.
* Add auto-repair for server/local build hash mismatches and ambiguous `bundleCandidates`.
* Strip query strings from script `src` before `fs.existsSync` in `injectEsm` validation.
* Add A2.5 hash coherence gate before `injectEsm` runs.

### ESM Support
* Replace `registerStreamProtocol` with `protocol.handle` for Electron 33+ compatibility.
* Use `net.fetch()` proxy for `meteor://` protocol (required by `protocol.handle`).
* Patch dev-server JS responses for ESM compatibility: inject `var global = this`, strip `type=module`, polyfill `import.meta`.
* Fix `import.meta` polyfill in dev-mode JS patching for classic scripts.
* Use classic scripts + `import.meta` polyfill (no `type=module`) to fix bare global `ReferenceError`.
* Patch `__meteor_runtime_config__` DDP URL in dev-mode HTML.
* Patch dynamic `import.meta` on force reload in production.
* `injectEsm()` must NOT set `type=module` on script tags.

### HCP (Hot Code Push) Improvements
* Rename `cordova.js` to `desktop-hcp.js`; remove `cordovaCompatibilityVersion`.
* Inject `desktop-hcp.js` script tag into `index.html` during build.
* Accept `/cordova.js` as a legacy alias for `/desktop-hcp.js` in `WwwHandler`.
* Inject cordova loader before script tags with attributes.
* Add fallback path for `desktop-hcp.js` in `WwwHandler`.
* Add 5 fail-fast guardrails to skeleton autoupdate for Meteor 3.x.

### Dependency Debloat
* Replace `node-fetch` with native `fetch` throughout (`meteorApp.js`, skeleton autoupdate modules).
* Replace `response.buffer()` with `arrayBuffer()` + `Buffer.from()` for native fetch compatibility.
* Replace `shelljs` with native `fs`/`child_process` in 7 lib files and the skeleton runtime.
* Remove `lodash` and `rimraf` from skeleton dependencies; replace with native JS/Node equivalents.
* Remove `isbinaryfile`; replace with `.node` extension check in `binaryModulesDetector`.
* Remove `del` (ESM-only) and replace with `fs` builtins.
* Eliminate `dist/` build step — point `package.json` directly to `lib/`.
* Remove dead Electron <5 `semver` check from `skeleton/app.js`.

### Build Hardening & Validation Gates
* Add `validateDesktopAsar()` post-pack validation with dynamic file discovery.
* Add A2 bundle structure and A3 `meteor.asar` validation gates (A3 is a hard gate).
* Add A4 and A7 validation gates to `electronApp`.
* Add A5 dev/prod parity canary and A6 boot smoke test to skeleton.
* Add post-`injectEsm` validation guardrails (A1).
* `getMeteorClientBuild()` catch block now calls `process.exit(1)` after logging.
* Every error path in `meteorApp.build()` and `electronApp.build()` either throws or calls `process.exit(1)`.
* `validateMeteorAsar` `rootJsFiles` filter excludes `node_modules/` and `dynamic/` paths.
* Run `transpileAndMinify()` before `packSkeletonToAsar()` in `beforeBuild`.
* Guard `desktopTmp.root` in `transpileAndMinify` with `fs.existsSync`.

### Reliability Fixes
* Add `maxRetries:3` + `retryDelay:150` to all recursive `fs.rmSync` calls (fixes ENOTEMPTY races on macOS).
* Run `chmodRecursive()` on all platforms in `copyBuild()`, not just Windows.
* Surface 3 silent errors as hard failures; fix 10+ additional silent error paths in `meteorApp.js`.
* Apply `IsDesktopInjector` patches in dev-mode protocol handler.
* Fix FSEvents watcher warning noise in stderr handler.
* Fix `bundler.js` `requireLocal` imports to use `lib/` instead of `dist/`.
* Replace dynamic `import()` with `execFileSync` to asar CLI in `bundler.js`.
* Abort build when `getMeteorClientBuild` fails (was silently continuing).

### Cordova Cleanup
* Remove dead `web.cordova` assignment patterns (`.isCordova=!0`, `.isCordova=!1`) from patching logic.
* Remove Cordova references from CLI, tests, and docs.
* Remove dead `web.cordova` patterns and stale Cordova comments from skeleton.
* `isDesktopInjector.js` `isCordova` regex patterns remain functional (required for Meteor internals).

### Build Infrastructure
* Upgrade CI workflows: remove `Meteor/dist/`, add `setup-node`, fix publish pipeline.
* Upgrade ESLint to v10 with flat config.
* Use local plugin symlinks instead of Atmosphere in `ensureDesktopHCPPackages`.
* Replace `@meteor-community/meteor-desktop` refs with `@a4xrbj1/meteor-desktop` in bundler plugin.
* Disable `enableRemoteModule` in `skeleton/app.js` for security.
* Add `typescript` as devDependency (ESLint peer dep).
* Upgrade `actions/checkout` and `actions/cache` from v4 to v5.

## v4.1.2 <sup>01.03.2026</sup>
* Fix CLI macOS target option parsing by using the correct `--mac` long flag.
* Modernize protocol registration in the skeleton app to remove deprecation warnings on newer Electron versions.

## v3.3.0
* Refactored fiber/futures syntax to ES6 async/await syntax [`#43`](https://github.com/Meteor-Community-Packages/meteor-desktop/pull/43) by [@awatson1978](https://github.com/sponsors/awatson1978)

## v3.2.1
* Minor version upgrade of NPM dependencies
* Fix registering custom 'meteor' scheme [`#39`](https://github.com/Meteor-Community-Packages/meteor-desktop/pull/39) by [@ramijarrar](https://github.com/ramijarrar)

## v3.2.0 <sup>07.12.2023</sup>
* Updated electron to v17
Make sure to update your electron and electron-builder versions to:
```
"electron": "17.4.11",
"electron-builder": "24.6.4",
```

## v3.1.1 <sup>22.10.2023</sup>
* Fix issue with single instance, which causes error with opening already opened app on windows
* Fixes for devEnvSetup.js
* Fix: do not download new version when desktopHCP is set to false
* Dynamically get preset-env version
* Fix addition of desktop script
* Don't SIGKILL Meteor when a desktop build terminates normally
* Fix integration tests

## v3.1.0 <sup>09.03.2022</sup>
* Updated Electron to v11

## v3.0.1 <sup>12.04.2022</sup>
* Attempt to fix version constraint issue

## v3.0.0 <sup>11.04.2022</sup>
Fixed to work with Meteor 2.6+ Node 14+.
* Updated `shelljs` to `0.8.5`.
* Fix bundler plugin to pass non-uglified `code` instead of `undefined` to `fs.writeFileSync` in dev mode.
* Updated build configs to use Meteor 2.6 when building + testing.
* Updated `chokidar` dependency from 2.x to 3.x for `meteor-desktop-bundler` and `meteor-desktop-watcher` packages.

Breaking: changes to publish packages under a new name.
* `meteor-desktop` npm package renamed to `@meteor-community/meteor-desktop`
* `omega:meteor-desktop-bundler` Atmosphere package renamed to `communitypackages:meteor-desktop-bundler`
* `omega:meteor-desktop-watcher` Atmosphere package renamed to `communitypackages:meteor-desktop-watcher`
* Updated all references to these package names in the code.
* Removed old wojtkowiak build links in README.
* Removed Contributing and Roadmap README entries.

## v2.2.5 <sup>24.01.2020</sup>

* Fixed issue with packaging [`#248`](https://github.com/wojtkowiak/meteor-desktop/issues/248)

## v2.2.4 <sup>21.01.2020</sup>

This is a community maintained release:

* Update some dependencies and fixes some vulnerabilities
* Added support for Electron 5 (by [`KoenLav`](https://github.com/KoenLav) in [`#227`](https://github.com/wojtkowiak/meteor-desktop/pull/227))
* Allow config header Access-Control-Allow-Origin on LocalServer module (by [`cbh6`](https://github.com/cbh6) in [`#216`](https://github.com/wojtkowiak/meteor-desktop/pull/216))
* Fix mas build (by [`wojtkowiak`](https://github.com/wojtkowiak)) in [`#214`](https://github.com/wojtkowiak/meteor-desktop/pull/214))
* Fix mac builds (by [`Strangerxxx`](https://github.com/Strangerxxx) in [`#237`](https://github.com/wojtkowiak/meteor-desktop/pull/237))
* Update default electron version to latest (6.0.1)
* Added support for private npm repository

**Recommended versions:**
* [`electron`](https://github.com/electron/electron) -> `6.1.7`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) -> `21.2.0`

## v2.0.0 <sup>02.10.2018</sup>

The main aim of this version is to decouple `electron`, `electron-builder` and `electron-packager` from this package.
Until now every `meteor-desktop` release came with specific versions of those pinned to it.
Now you are free to use any version with your meteor project. Just add them to your `devDependencies`.
If you will not, `meteor-desktop` adds the recommended versions automatically when needed.

From now every `meteor-desktop` release will provide a recommended versions numbers of these dependencies.
By default, I will try to make `meteor-desktop` compatible within the compatibility version of the recommended version i.e. if the recommended electron version is `2.0.10` you should still be able to use any `2.x.x` version without problems.

**Recommended versions:**
* [`electron`](https://github.com/electron/electron) -> `2.0.10`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) -> `20.28.4`


**BREAKING:**
* support for Squirrel autoupdate mechanism ended, if you wish to continue with it, add the `electron-builder-squirrel-windows` dependency to your `devDependencies` and move its settings to `squirrel` section in settings i.e.:
    ```
        "squirrel": {
            "autoUpdateFeedUrl": "http://127.0.0.1/update/:platform/:version",
            "autoUpdateFeedHeaders": {},
            "autoUpdateCheckOnStart": true
        },
    ```

    All builtin support will be definitely removed in January 2019.

## v1.7.0 <sup>28.09.2018</sup>
* [`electron`](https://github.com/electron/electron) was updated to `2.0.10`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.28.4`
* `electron-builder-squirrel-windows` was updated to `20.28.3`
* new functionality/cli setting `--prod-debug` which forces devTools to be included in a production build, if you want this to be preserved after desktopHCP you need to run Meteor server with `METEOR_DESKTOP_PROD_DEBUG=1`

## v1.6.0 <sup>25.07.2018</sup>
* [`electron`](https://github.com/electron/electron) was updated to `2.0.5`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.23.1`
* `electron-builder-squirrel-windows` was updated to `20.23.0`
* new functionality and new setting `exposedModules` which allows to expose any Electron renderer module i.e. `webFrame` which when defined in the settings will be available as `Desktop.electron.webFrame`
* fixed HCP switching to new version only after app restart

## v1.5.0 <sup>11.07.2018</sup>
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.20.0`
* `electron-builder-squirrel-windows` was updated to `20.19.0`

## v1.4.0 <sup>09.07.2018</sup>
* [`electron`](https://github.com/electron/electron) was updated to `2.0.4`

## v1.3.0 <sup>26.06.2018</sup>
* [`electron`](https://github.com/electron/electron) was updated to `2.0.3`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.16.2` (once again thanks to [devlar](https://github.com/develar) for accepting meteor-desktop specific pull requests PR [electron-builder#2975](https://github.com/electron-userland/electron-builder/pull/2975))
* `electron-builder-squirrel-windows` was updated to `20.16.0`

## v1.2.0 <sup>18.06.2018</sup>
* `-i, --ignore-stderr [string]` cli cmd added, normally using `-b` when meteor outputs anything to stderr the build gets terminated, but in some cases you might want to avoid that when for example npm package throws a deprecation warning into stderr, now you can make the build continue

Example - `npm run desktop -- build-installer -b` gets terminated because `meteor run` outputs a `Node#moveTo was deprecated. Use Container#append.` warning to stderr. This will kill your build and prevent from going further. Because clearly that is something we can live with you can go forward with:
```  
npm run desktop -- build-installer -b -i "Node#moveTo"
```

You do not have to put the whole line, just any part of it that should only be found in that message.

## v1.1.0 <sup>23.05.2018</sup>
* `setDefaultFetchTimeout` and `call` methods added to both `Module` and `Desktop`
* [`electron`](https://github.com/electron/electron) was updated to `2.0.2`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.14.7`   
* `electron-builder-squirrel-windows` was updated to `20.14.6`

**FIXES**
* fix [#165](https://github.com/wojtkowiak/meteor-desktop/issues/174) `meteor://` protocol is now registered as secure origin
* `bundler` caching was disabled for production builds as you might have accidentally got a development `desktop.asar` build into your production build

## v1.0.0 <sup>21.05.2018</sup>
Meteor App serving mechanism was changed to utilise `registerStreamProtocol` and serve
the app on constant `meteor://desktop` url instead of setting a http server which serves over `http://127.0.0.1:<random_port_on_every_start>`.

This finally solves the longstanding problems with `IndexedDB` and `localstorage` not being persistent.

Please verify thoroughly if your app is working fine after this change and reports any problems you encounter.

The localstorage contents will be migrated if you are updating your app from pre `1.0.0`.

However, if you are using the `meteor-desktop-localstorage` plugin you have to make a migration yourself. The easiest way is to copy the plugin desktop code as your module in `.desktop` and on your app start get the contents with `getAll` and save them to the browser's localstorage.     

* [`electron`](https://github.com/electron/electron) was updated to `2.0.1`
* `MD_LOG_LEVEL` is now respected
* `-d`/`--debug` option added to run electron with `--debug=5858` switch
* `beforeLocalServerInit` event added to the `eventsBus`
* `METEOR_DESKTOP_DEBUG` now produces a lot more info from bundler plugin while building meteor project
* default installer in the scaffold for Windows is now set to `nsis`

**DEPRECATIONS:**
* builtin support for squirrel auto update

**BREAKING:**
* support for the `meteor-desktop-localstorage` plugin is removed, you will not be able to use this plugin anymore

## v0.19.0 <sup>17.05.2018</sup>
**WARNING:** in this version the localStorage/indexedDB is not working properly (it's not persistent) - please upgrade to `1.0.0`
* `desktopHCP` bundler plugin was enhanced with cache - that should speed up your rebuilds
* issue with app not being rebuilt after an error in `.desktop` code should be resolved now (watcher should still work even after a syntax error while compiling `.desktop`)
* [`electron`](https://github.com/electron/electron) was updated to `2.0.0`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.13.5`   
* `electron-builder-squirrel-windows` was updated to `20.13.1`

#### v0.18.1 <sup>10.05.2018</sup>
* fix `ReferenceError: context is not defined` in `build-installer` on `OSX`

## v0.18.0 <sup>08.05.2018</sup>
* `moduleLoadFailed` event added
* fixed desktop HCP app restart, this is now triggered with `app.quit` instead of `app.exit` which now fires properly all callbacks
* [`electron`](https://github.com/electron/electron) was updated to `1.8.6`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.11.1`   
* `electron-builder-squirrel-windows` was updated to `20.11.0`
* [`electron-packager`](https://github.com/electron-userland/electron-packager) was updated to `12.0.2`

#### v0.17.2 <sup>30.04.2018</sup>
* fix [#165](https://github.com/wojtkowiak/meteor-desktop/issues/165) `build-installer` failing on windows

## v0.17.0 <sup>26.04.2018</sup>
<sup>republished as `v0.17.1`</sup>
* upgraded to `babel@7`, which is now used to compile both the meteor-desktop itself and the produced app
* upgraded to `uglify-es`
* dropped support for `Meteor` < `1.4`
* code in your `.desktop` is now transpiled for `node@8`

## v0.16.0 <sup>25.04.2018</sup>
* [`electron`](https://github.com/electron/electron) was updated to `1.8.4`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.10.0`   
* `electron-builder-squirrel-windows` was updated to `20.10.0`
* [`electron-packager`](https://github.com/electron-userland/electron-packager) was updated to `12.0.1`
* added `Module.fetch` and `Desktop.respond` to be able to fetch from the main process side (as for now fetch was only implemented for renderer)
* fixed `Module.once` which was only passing single argument
* fixed `linkPackages` not working anymore

#### v0.15.3 <sup>16.04.2018</sup>
* fixed `extract` functionality for Mac/Linux - `electron-builder` prepackaged app is now correctly found on every platform   

#### v0.15.2 <sup>11.04.2018</sup>
* fixed compatibility version being calculated differently in bundler plugin and `package`/`build-installer` flow

#### v0.15.1 <sup>10.04.2018</sup>
* fixed compatibility version being calculated differently in bundler plugin and `package`/`build-installer` flow

#### v0.15.1 <sup>10.04.2018</sup>
* fixed `extract` functionality for Mac (the `node_modules/.bin` entries are now also automatically extracted when their package is extracted)

## v0.15.0 <sup>08.04.2018</sup>
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.8.2`   
* `electron-builder-squirrel-windows` was updated to `20.8.0`
* [`electron-packager`](https://github.com/electron-userland/electron-packager) was updated to `12.0.0`
* added automatic detection of modules that should not be packed into asar, additionally you can manually specify those via `extract` settings

#### v0.14.4 <sup>20.03.2018</sup>
* additional fixes to [`electron-builder`](https://github.com/electron-userland/electron-builder) integration

#### v0.14.2 <sup>19.03.2018</sup>
<sup>republished as `v0.14.3`</sup>
* `.desktop` version hash will include a `dev`/`prod` suffix as a quick fix to `meteor` development or production build producing the same version hash

## v0.14.0 <sup>16.03.2018</sup>
<sup>republished as `v0.14.1`</sup>
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.5.1`   
* `electron-builder-squirrel-windows` was updated to `20.5.0`
* [`electron-packager`](https://github.com/electron-userland/electron-packager) was updated to `11.1.0`

#### v0.13.1 <sup>15.03.2018</sup>
* additional fix to [`electron-builder`](https://github.com/electron-userland/electron-builder) integration, fixes [#149](https://github.com/wojtkowiak/meteor-desktop/issues/149)
* desktop HCP meteor plugins are no longer unnecessarily constantly added when on Windows even if they are already there

## v0.13.0 <sup>09.03.2018</sup>
* [`electron`](https://github.com/electron/electron) was updated to `1.7.12`
* `npm` has been removed from being a direct dependency, dependencies installation is now performed entirely by [`electron-builder`](https://github.com/electron-userland/electron-builder) which calls your `meteor npm` or system's `npm`
* local npm dependencies (`file:`) are now installed by [`install-local`](https://github.com/nicojs/node-install-local)
* native modules rebuild mechanism is enabled by default now and there is no way of turning it off (`rebuildNativeNodeModules` is obsolete and no longer taken into account)
* several small improvements to [`electron-builder`](https://github.com/electron-userland/electron-builder) integration

## v0.12.0 <sup>23.02.2018</sup>
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `20.0.8`   
* `electron-builder-squirrel-windows` was updated to `20.0.5`
* [`electron-packager`](https://github.com/electron-userland/electron-packager) was updated to `11.0.1`
* **DEPRECATIONS**:
    - building for `squirrel.windows` is not encouraged and from `1.0.0` the default Windows target will be `nsis`  

it's more than sure that you will have to update your [`electron-builder`](https://github.com/electron-userland/electron-builder)/[`electron-packager`](https://github.com/electron-userland/electron-packager) configuration since it's a big shift from the old versions, create a new meteor project with blank scaffold (`npm run desktop -- init`) and take a look at the new `settings.json` as that might give you some hints

#### v0.11.3 <sup>17.01.2018</sup>
- added `desktopHCPCompatibilityVersion` setting to restore ability to override desktopHCP compatibility version
- added `singleInstance` setting

#### v0.11.2 <sup>29.11.2017</sup>
- fixed local filesystem URL whitespace support [#133](https://github.com/wojtkowiak/meteor-desktop/issues/133) (thanks [met5678](https://github.com/met5678), PR: [#134](https://github.com/wojtkowiak/meteor-desktop/pull/134) )
- start startup timer on _cold_ start if a new version is used for the first time [meteor#9386](https://github.com/meteor/meteor/issues/9386)

#### v0.11.1 <sup>06.11.2017</sup>
- republished `0.11.0` with Meteor 1.5 because of [meteor#9308](https://github.com/meteor/meteor/issues/9308)

## v0.11.0 <sup>03.11.2017</sup>
<sup>republished as 0.11.1</sup>
* [`electron`](https://github.com/electron/electron) was updated to `1.7.9` ([PR](https://github.com/wojtkowiak/meteor-desktop/pull/126))

## v0.10.0 <sup>12.09.2017</sup>
> v0.9.0 failed to publish

* added `windowSettings` event

#### v0.8.1 <sup>10.08.2017</sup>

* fix for respecting `--ia32` in `run`/`build`/`package`

## v0.8.0 <sup>05.07.2017</sup>

- added `builderCliOptions` that allow you to specify additional electron-builder CLI options e.g.
 for publishing artifacts (thanks to [ramijarrar](https://github.com/ramijarrar), related
 [PR](https://github.com/wojtkowiak/meteor-desktop/pull/112))

#### v0.7.2 <sup>10.06.2017</sup>

* fix for the case when `eTag`s are stripped from the http response when proxying meteor
server through proxy [#107](https://github.com/wojtkowiak/meteor-desktop/issues/107)
* fix for supporting Meteor 1.5 which actually was failing because of `1.5` being a non semver
strict version [#103](https://github.com/wojtkowiak/meteor-desktop/issues/103)

#### v0.7.1 <sup>08.05.2017</sup>
* fixed bug in `Desktop.fetch` which when called multiple times with the same event, was serving the response only for the first call [#79](https://github.com/wojtkowiak/meteor-desktop/issues/79)   

## v0.7.0 <sup>04.05.2017</sup>
- added `--meteor-settings <path>` cmd option to pass `--settings <path>` to meteor when building with `-b`
* fix to make `-b` not fail because of [meteor#8592](https://github.com/meteor/meteor/issues/8592)
* documented `beforeReload` event

#### v0.6.2 <sup>12.04.2017</sup>
* fixed [#82](https://github.com/wojtkowiak/meteor-desktop/issues/82)   
* [`electron`](https://github.com/electron/electron) was updated to `1.4.16`

#### v0.6.1 <sup>02.03.2017</sup>
- `meteor-desktop-splash-screen` version in the default scaffold updated to [`0.3.0`](https://github.com/wojtkowiak/meteor-desktop-splash-screen#changelog)

## v0.6.0 <sup>27.02.2017</sup>
- added experimental fix for `localStorage` getting lost - you can enable it by adding `"experimentalLocalStorage": true` to `settings.json`
- `meteor-desktop-splash-screen` version in the default scaffold updated to [`0.2.0`](https://github.com/wojtkowiak/meteor-desktop-splash-screen#changelog)
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `13.11.1`
* `electron-builder-squirrel-windows` was updated to `13.10.1`
* [`electron-packager`](https://github.com/electron-userland/electron-packager) was updated to `8.5.2`

#### v0.5.3 <sup>17.02.2017</sup>
- `omega:meteor-desktop-bundler` now fails when disk operation fails (`shelljs.config.fatal =
true`)   
- `METEOR_DESKTOP_DEBUG` env var introduced (currently only prints additional info for `bundler`
plugin)

#### v0.5.1 <sup>15.02.2017</sup>
- fixed `extracted` directory getting lost when building for platform/arch different from the
host
- fixed dependency loading for desktopHCP `bundler` plugin

## v0.5.0 <sup>08.02.2017</sup>
* `Desktop.fetch` rejects with `timeout` string in case of timeout
* you can now see internal backlog of this project in Taiga
[here](https://tree.taiga.io/project/wojtkowiak-meteor-desktop/kanban) - roadmap
will be published in form of epics
* [`electron`](https://github.com/electron/electron) was updated to `1.4.15`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `13.0.0`
* `electron-builder-squirrel-windows` was updated to `13.2.0`
* [`electron-packager`](https://github.com/electron-userland/electron-packager) was updated to `8.5.1`

## v0.4.0 <sup>11.01.2017</sup>
* added `showWindowOnStartupDidComplete` option to help fixing [#42](https://github.com/wojtkowiak/meteor-desktop/issues/42)   
* various fixes for `0.3.0` issues reported [#51](https://github.com/wojtkowiak/meteor-desktop/issues/51)
* [`electron`](https://github.com/electron/electron) was updated to `1.4.14`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `11.2.4`
* `electron-builder-squirrel-windows` was updated to `11.2.3`
* [`electron-packager`](https://github.com/electron-userland/electron-packager) was updated to `8.5.0`

## v0.3.0 <sup>10.01.2016</sup>
* `localServer` was rewritten to use `send` instead of `serve-static`
[[5f084e6](https://github.com/wojtkowiak/meteor-desktop/commit/5f084e64fa11e4894e4c7c8d541b0b02a8676111)]
* url aliases for local filesystem and `.desktop/assets` added
([more](README.md#accessing-local-filesystem-in-meteor))
* building for Windows Store is now possible (thanks to hard work of
[@develar](https://github.com/develar))
* default dependencies for `Skeleton App` were updated
[[7d6e00d](https://github.com/wojtkowiak/meteor-desktop/commit/7d6e00d803f472f47d4e1ee38de2cd8240fbc468),
[1d1075a](https://github.com/wojtkowiak/meteor-desktop/commit/1d1075a1eec288c1372ccd001c197fab29f71980)]
(this changes compatibility version, so apps built with <0.3.0 will not receive desktopHCP
updates)
* [`electron`](https://github.com/electron/electron) was updated to `1.4.13`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `11.2.0`
* `electron-builder-squirrel-windows` was updated to `11.2.0`
* [`electron-packager`](https://github.com/electron-userland/electron-packager) was updated to `8.4.0`

#### v0.2.6 <sup>17.12.2016</sup>
 - added some additional log messages

#### v0.2.5 <sup>10.12.2016</sup>
- republished `0.2.4`

#### v0.2.4 <sup>09.12.2016</sup>
- fixed [#40](https://github.com/wojtkowiak/meteor-desktop/issues/40) [[#33](https://github.com/wojtkowiak/meteor-desktop/issues/33)]

#### v0.2.3 <sup>06.12.2016</sup>
- fixed [#33](https://github.com/wojtkowiak/meteor-desktop/issues/33)   

#### v0.2.2 <sup>29.11.2016</sup>
- republished `0.2.1` because of published plugins being in an unknown, erroneous
state [meteor#8113](https://github.com/meteor/meteor/issues/8113)   

#### v0.2.1 <sup>23.11.2016</sup>
- fixed `rebuildNativeNodeModules` which stopped working after update of
[`electron-builder`](https://github.com/electron-userland/electron-builder)

## v0.2.0 <sup>17.10.2016</sup>
* several types of npm dependencies versions declarations are now supported i.e.: local paths,
file protocol, GitHub links and http(s) links -> [npm documentation](https://docs.npmjs.com/files/package.json#dependencies)
* development environment setup script was added
* specifying target platforms for `build-installer` is now not restricted -
check [Building installer](README.md#building-installer), fixes [#14](https://github.com/wojtkowiak/meteor-desktop/issues/14)
* [`electron`](https://github.com/electron/electron) was updated to `1.4.6`
* [`electron-builder`](https://github.com/electron-userland/electron-builder) was updated to `8.6.0`

#### v0.1.4 <sup>16.11.2016</sup>
* fixed [#22](https://github.com/wojtkowiak/meteor-desktop/issues/22)  
* fixed bug in uncaught exception handler in the scaffold - check [here](https://github.com/wojtkowiak/meteor-desktop/commit/1dc8347f18d2ebc1dfb3f875a66e1d5206441af8)

#### v0.1.3 <sup>15.11.2016</sup>
- added warning for possible console syntax mistake when invoking with command or
option (missing ` -- ` delimiter)

#### v0.1.2 <sup>13.11.2016</sup>
- fixed [#10](https://github.com/wojtkowiak/meteor-desktop/issues/10)

#### v0.1.1 <sup>10.11.2016</sup>
- `meteor-desktop-splash-screen` version in the default scaffold updated to [`0.0.31`](https://github.com/wojtkowiak/meteor-desktop-splash-screen#changelog)

## v0.1.0 <sup>07.10.2016</sup>
- first public release
