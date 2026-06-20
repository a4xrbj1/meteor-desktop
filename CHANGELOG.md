## v6.0.21 <sup>20.06.2026</sup>

**Stage 2 — per-asset `sri` integrity verification before HCP swap (seed `meteor-desktop-1820`).** Ships the integrity check deferred from v6.0.20. During a web-HCP download the desktop now verifies each downloaded asset's bytes against the manifest's `sri` (= `base64(sha512(content))`) and rejects a mismatch before the asset is staged — the strong-integrity guarantee the legacy `hash`-vs-ETag path could not provide (the legacy `hash` is not a content digest of the served bytes, and ETags are often absent).

The v6.0.20 deferral was blocked by a production data bug (seed `meteor-desktop-1d08`) where `app.yourdna.family` served `packages/modules.js` bytes that did not match its own manifest `sri` (73/74 assets matched; `modules.js` failed persistently). **That blocker is now resolved.** Root cause: a Meteor 3.4.1 bundler ordering bug — `tools/isobuild/bundler.js` computes each client `program.json` entry's `size`/`hash`/`sri` *before* `writeFile` strips `//# sourceMappingURL`/`sourceURL` comments; with `@meteorjs/rspack`, `modules.js` ships un-minified carrying those comments, so its manifest digest describes a ~5089-byte phantom (upstream `meteor#10710` / PR #14476). Fixed in the consumer (frontend) by a server-side `Meteor.startup()` patch that re-derives each asset's `size`/`sri` from the on-disk bytes and corrects webapp's served `/__<arch>/manifest.json` in place (frontend commit `979144ef5`); **prod-verified** — all 74 assets' manifest `sri` now equal the served bytes, so a strict client no longer rejects a self-consistent production bundle.

### Features

* **Per-asset sha512/`sri` integrity check (`skeleton/modules/autoupdate/`).** `assetManifest.js` threads the manifest `sri` onto each `ManifestEntry`; `assetBundle.js` carries it on each `Asset` (constructor gains an `sri` param after `hash`; all three call sites updated); `assetBundleDownloader.js#verifyResponse` computes `base64(sha512(body))` on the raw downloaded body (before isDesktop injection) and throws `sri mismatch` when it differs from `asset.sri`. The check is **gated on `asset.sri` being present**, so legacy manifests and sri-less assets (`index.html`, source maps) are skipped — never wrongly rejected. The digest format (raw `base64(sha512)`, no `sha512-` prefix) matches the frontend 1d08 fix exactly, so it passes against the now-self-consistent prod manifest.
  * **Tests** (`tests/unit/skeleton/assetBundleDownloader.test.js`): accepts a body whose sha512 matches the manifest `sri`; rejects a tampered body (`/sri mismatch/` — inversion, Rule 41); skips when the asset has no `sri`. Full suite **224 passing**.
  * **Consumer exercise (Rule 48):** exercised end-to-end via the frontend `npm run desktop build` as part of the v5.1.1 desktop release (post-cutover), against the 1d08-fixed production HCP server.

### Cutover note

The fatal `sri` check must reach a self-consistent server. During the production cutover (two instances briefly co-running), the old instance still served the stale manifest; roll the new desktop build out only after the old instance is fully off — a strict client hitting the stale instance would reject the bundle (gracefully, retrying) until then.

## v6.0.20 <sup>19.06.2026</sup>

Dev-tooling, test, lint-cleanup, **and one functional feature** (the e490 web-HCP revival — **Stage 1**). The `typescript` devDep (fa84) and the `tests/` changes (5602, fcde) leave the published artifact **byte-identical**; the lint cleanup (fbee) and **e490** Stage 1 textually modify shipped `skeleton/`+`lib/` files. e490 Stage 1 is a behavioral change to the renderer HCP bridge + the bundle version-coherence check, so the Rule 48 consumer exercise was performed: a full `npm run desktop build` against live production (see *Tests + consumer verification* below) **plus** a fresh verify that the published `6.0.20` tarball installs into a clean consumer project and its real `node_modules/.bin/meteor-desktop` entry runs via symlink (Stage 1 G1 bootstrap confirmed present in the packed `skeleton/`; `prepublishOnly` smoke gate green). **Stage 2 — per-asset `sri` integrity (seed `meteor-desktop-1820`) — is deferred** to a later release: it is code-complete on branch `feat/desktop-hcp-sri-integrity-1820` but **blocked by a production data bug** (seed `meteor-desktop-1d08`) where `app.yourdna.family` serves `packages/modules.js` bytes that do **not** match its own manifest `sri`/`hash`/`size` (73/74 assets match; `modules.js` fails persistently, origin-served). A strict integrity check would reject the bundle and break HCP until prod is self-consistent; the web app tolerates it today only because prod HTML emits zero `integrity=` attributes.

### Features

* **Revive the JS-bundle hot-code-push (web HCP) path for Meteor 3.x web.browser desktop builds (seed `meteor-desktop-e490`, Stage 1).** Incremental JS/asset updates were inert: the desktop never downloaded a new bundle and, even if it had, the bundle was rejected by the integrity check. Two independent gaps, both fixed in the fork (no server/consumer change required):
  * **G1 — missing trigger (`skeleton/desktop-hcp.js`).** In a web.browser build there is no cordova-plugin-meteor-webapp consumer, so nothing drove the `WebAppLocalServer` bridge: the stock autoupdate client reacts to a new version by calling `Reload._reload()` (an in-place reload), never `WebAppLocalServer.checkForUpdates()` — which had **zero callers**. Added a deferred renderer bootstrap that, once Meteor is up, (a) calls `checkForUpdates()` on startup + on a 10-min poll to DOWNLOAD a staged bundle, and (b) registers `onNewVersionReady` to APPLY it by routing through Meteor's standard `Reload._reload()` pipeline — so the app's existing `Reload._onMigrate` gate (defer on desktop, apply at a safe route) still decides *when* to swap. Download-only + apply-via-the-existing-gate: no second reload mechanism, no bypass of the "holy operations" gating.
  * **G2 — version-coherence (`skeleton/modules/autoupdate/assetBundleDownloader.js`).** `verifyRuntimeConfig` read only the legacy top-level `autoupdateVersionCordova`/`autoupdateVersion`, which Meteor 3.x web.browser leaves **null**, so every downloaded `index.html` failed verification ("missing both…"). It now falls back to the never-null per-arch version at `autoupdate.versions['web.browser'].version` (== the `__browser/manifest.json` version it fetched), after the legacy fields, preserving the coherence check (a mismatching version is still rejected). Verified live: production `app.yourdna.family` serves top-level `autoupdateVersion: null` but `autoupdate.versions['web.browser'].version` and the manifest version are both `7e3c0186…`.
  * **G3 — blast-radius hardening (`skeleton/modules/autoupdate/assetBundleManager.js` + `desktop-hcp.js`), surfaced by the live run.** G1 makes `checkForUpdates()` fire routinely, which first exercised a dormant path: the manifest-fetch chain had **no `.catch`**, so an unreachable HCP server (offline / wrong URL) surfaced as an `UnhandledPromiseRejection`. Added a `.catch` routing fetch failures through the existing `didFail` → `onError` path, and registered a `WebAppLocalServer.onError` sink in the bootstrap (the bridge's `error` handler would otherwise invoke a null callback). Verified: a dead-URL `checkForUpdates` now resolves via `onError` with **zero** unhandled rejections.
  * **Unchanged / relied upon:** `isDesktopInjector` already sets `Meteor.isDesktop` and makes `startupDidComplete()` fire on desktop (so a downloaded bundle is **not** reverted by the 20-s startup timer); the atomic-rename swap, `lastKnownGoodVersion` rollback, and userData `versions/` store are pre-existing. Out of scope for Stage 1 (separate seeds `1820`/`0a0e`/`5aa1`): per-asset sha512/`sri` verification, the `compatibilityVersion` native-vs-JS gate, and per-phase progress/observability.
  * **Tests + consumer verification (Rule 48/56):** `tests/unit/skeleton/assetBundleDownloader.test.js` (G2 — accepts per-arch version, rejects a mismatch [inversion, Rule 41], throws when all three sources absent, still accepts the legacy shapes) and `tests/unit/skeleton/desktopHcpBootstrap.test.js` (G1 — loads the real `desktop-hcp.js` in a vm sandbox; asserts `checkForUpdates` fires on Meteor startup, the periodic poll is scheduled, `onNewVersionReady` routes through `Reload._reload`, defers until Meteor exists). Functional `tests/functional/modules/autoupdate.test.js` (43) still green. **End-to-end on the packaged app:** a `npm run desktop build` (A7 gates pass; `injectEsm` handles `desktop-hcp.js`) launched with `customHCPUrl` pointed at production downloaded the entire prod bundle (`7e3c0186…`), `verifyRuntimeConfig` accepted the real prod `index.html` (`lastDownloadedVersion` set, bundle staged under `versions/`), with **zero** unhandled rejections — the fix observed working against live production.

### Bug Fixes

* **Restore `typescript` (`~6.0.3`) to `devDependencies` — fixes the `npm run lint` crash (`Error: Cannot find module 'typescript'`) (seed `meteor-desktop-fa84`).** `typescript` was dropped in v6.0.13 (commit `4a7380b`) on a "zero source imports" basis, but it is a **required peer of the active lint toolchain**: `eslint.config.js` imports `eslint-config-airbnb-extended`, whose single top-level export (`dist/index.mjs`) eagerly loads `typescript-eslint` → `@typescript-eslint/parser` → `typescript-estree`, which `require('typescript')` at module-load time. The package therefore cannot even be imported without `typescript` present, so every `eslint`/`npm run lint` invocation crashed before linting a single file. This is **not** a re-added dead dependency (the "no direct imports" test missed the indirect mandatory peer relationship) — it supersedes the transient `--no-save` workaround noted in v6.0.18's verification. Range `~6.0.3` (`>=6.0.3 <6.1.0`) is pinned to match the toolchain's declared peer ceiling (`typescript-eslint@8` requires `typescript >=4.8.4 <6.1.0`); a caret would let a future `typescript@6.1.0` violate that peer on a fresh non-locked install. `typescript@6.0.3` has `engines.node: ">=14.17"` and zero transitive deps, so this does **not** reintroduce the EBADENGINE noise that motivated the v6.0.13 cleanup (that was `cacache@21`, a regular `dependency`).

### Tests

* **Fix the `meteorApp #validateHashCoherence 'throws when every stylesheet link is unresolvable'` test (seed `meteor-desktop-5602`; duplicate `-3eed` closed).** The test asserted `validateHashCoherence()` throws `/style-less desktop build/` for an `index.html` whose only stylesheet link is unresolvable (empty manifest), but it instead threw `TypeError: Cannot read properties of undefined (reading 'skipMobileBuild')` at `lib/meteorApp.js:1148` — the block's `newInstance` mock supplied `env.paths` but omitted `env.options`, which production legitimately requires (`Env` sets `this.options = options` and reads `options.skipMobileBuild` at construction, `lib/env.js:14,20`; `validateHashCoherence` runs in the same build flow that already read `env.options.skipMobileBuild` at `meteorApp.js:290/332/350`). **Test-fixture defect, not a production bug** — fixed by completing the mock with `options: { skipMobileBuild: false }`, matching the `#checkPreconditions` block's existing pattern. No production code changed (Rules 6/23: no guard added for a runtime-unreachable state). The symmetric dev-mode branch (`skipMobileBuild: true` → demote-to-warning, `meteorApp.js:1148-1154`) is now covered by the dev-mode test below (seed `meteor-desktop-fcde`).
* **Add the dev-mode tolerance test for `validateHashCoherence` (seed `meteor-desktop-fcde`).** New `it('keeps unresolvable stylesheet links in dev mode (skipMobileBuild) instead of throwing')` exercises the symmetric branch of the 5602 throw: with `options: { skipMobileBuild: true }` and the same all-unresolvable fixture, `validateHashCoherence()` must NOT throw and must retain the `<link>` in `index.html` (the runtime rspack-dev-server AssetHandler proxy serves the CSS). `newInstance` gained an optional `optionOverrides` param (`options: { skipMobileBuild: false, ...optionOverrides }`) so the four existing tests keep production-mode defaults. Inversion (Rule 41): forcing the branch to `if (false)` makes the test fail with the `style-less desktop build` throw — confirmed by temporarily breaking the production guard and reverting.

### Lint / code style

* **Make `npm run lint` green: 101 errors → 0, 88 warnings → 0 (seed `meteor-desktop-fbee`).** Once fa84 unblocked the linter it surfaced 189 pre-existing findings. Resolved config-first (Strategy A) — relaxed only the rules that fought the project's documented or unavoidable conventions, each with an inline rationale in `eslint.config.js`: `max-len` 120→150 (workspace norm), `func-names` off (project uses anonymous function expressions), `no-underscore-dangle` off (`__dirname` ESM idiom, `__*ForTest` seams, `__meteor_runtime_config__`), `max-classes-per-file` off (co-located helper classes), `no-console` off (build CLI + the skeleton's `wrapConsoleMethod` logger routing), `import-x/no-rename-default` off (advisory), `import-x/no-useless-path-segments` off (ESM requires an explicit `/index.js`; its autofix produced an invalid `ERR_UNSUPPORTED_DIR_IMPORT`). Auto-fixed the safe stylistic rules (`prefer-template`, quotes, `object-shorthand`, …). Fixed genuine issues in source: a redundant `new RegExp(/…/)` wrapper, a nested ternary, two Promise-executor returns, a `path` shadow, `new queue()`→`new Queue()`, 8 over-150 lines (wrapped or disabled), 42 unused `catch (e)`→`catch {`, and assorted dead vars/imports. Behavior-critical/intentional patterns got documented per-line disables instead of risky rewrites (the escape-heavy HCP-injection `new RegExp` patterns, sequential `await`-in-loop, the deliberate `WebAppLocalServer` global). No behavior change. (Adding `lint` to CI — currently tests-only — is left as a future task.)

### Verification

* **ESLint runs again.** `npm run lint` (`eslint lib scaffold skeleton tests`) executes to completion instead of crashing; inversion confirmed — removing `typescript` reproduces the `Cannot find module 'typescript'` crash. It now surfaces **101 pre-existing errors / 88 warnings** on untouched source lines — all pre-existing (the diff touches only `package.json` + `package-lock.json`), filed separately per Rule 26 (seed `meteor-desktop-fbee`), not fixed here.
* **Full suite now `211 passing, 0 failing`** (was `209 passing, 1 failing` before this batch; the 5602 fix closed the last failure and the fcde dev-mode test adds one). Inversion (Rule 41): reverting the 5602 mock reproduces the `TypeError`; the green proves the code reaches the intended throw at `meteorApp.js:1157` — the `/style-less desktop build/` message exists nowhere else.
* **fbee verified to 0 errors / 0 warnings** independently of the subagents that applied the edits: full suite `211 passing`; CLI real-entry smoke (`node lib/bin/cli.js --version` loads `lib/`); `node --check` clean on all 24 changed shipped `lib/`+`skeleton/` files; behavior-sensitive fixes (the ternary, `packToAsar`'s braced executor, the `Queue` rename, `catch {}` conversions, the `protocol`/`urlStripLength`/`require` removals) reviewed and confirmed dead/identical.
* **Rule 48 status.** N/A for fa84 (eslint config resolution) and 5602/fcde (unit-test mocks) — dev-machine-only, never reached by `npm run desktop` / `desktop build`. For **fbee** the changes are behavior-preserving but DO touch shipped `lib/`+`skeleton/` code, so the full `npm run desktop` + `desktop build` consumer exercise is **recommended before the release that ships this batch** (deferred here — state-mutating per Rule 28 and requires the consumer's dev environment). CI (`test.yml`) does not run lint, so CI was never red.

## v6.0.19 <sup>08.06.2026</sup>

Patch release making the build pipeline compatible with **electron-builder / app-builder-lib 26**, which this release also adopts (`lib/defaultDependencies.js` → `electron-builder: 26.9.0`; `package.json` devDep `app-builder-lib: ^26.9.0`). app-builder-lib 26.x **removed** `out/util/packageDependencies.createLazyProductionDeps` (the module is now an empty stub) and stopped consuming the `productionDeps` field entirely — `installOrRebuild`/`rebuild` (`out/util/yarn.js`) now collect production deps internally via `node-module-collector`. `InstallerBuilder.prepareLastRebuildObject` (`lib/electronBuilder.js`) still called the removed helper unconditionally, so on app-builder-lib 26 it threw `TypeError: this.packageDependencies.createLazyProductionDeps is not a function`, breaking `npm run desktop` and `npm run desktop build` for every consumer (frontend seed `frontend-805d`). v6.0.18's published tarball still carries the unconditional call, so a clean `npm install` of the previously-published `6.0.18` reinstalls the broken build even where a local `node_modules` was hand-patched — this release exists to ship the fix to the registry (frontend seed `frontend-1be5`).

### Bug Fixes

* **Guard the obsolete `createLazyProductionDeps` call (`lib/electronBuilder.js:66` `prepareLastRebuildObject`).** Build `lastRebuild` (`frameworkInfo`/`platform`/`arch`) without `productionDeps`, then set `productionDeps` only when the legacy helper is still present (`typeof this.packageDependencies.createLazyProductionDeps === 'function'`). app-builder-lib < 26 keeps its precomputed-array behaviour; 26.x skips the dead field it no longer reads. Eliminates the `createLazyProductionDeps is not a function` crash on electron-builder 26 (commit `9d88179`).

### Also in this release

* **`chore(deps)`: bump all outdated npm packages to latest, incl. `app-builder-lib`/`electron-builder` → `^26.9.0`** (`06e3392`) — the bump that surfaced the `createLazyProductionDeps` removal the Bug Fix above accommodates.
* **`chore`: remove Codacy integration** (`7a01777`).
* **`test(cli)`: `.bin`-symlink main-guard coverage + `prepublishOnly` smoke gate** (`4592716`).

### Verification

* **Pre-publish smoke gate.** `scripts/prepublishOnly` → `scripts/prepublish-smoke.js` runs the published CLI bin through a `node_modules/.bin`-style symlink and asserts it prints `v6.0.19` before `npm publish` proceeds; ran locally clean against this bump.
* **Consumer-side defect reproduced and fixed.** The crash is the consumer report `frontend-805d` (`createLazyProductionDeps is not a function` under electron-builder `26.15.0`). The fix is exercised through frontend's real `node_modules/.bin/meteor-desktop` entry; the post-publish closing step is a clean `npm install` of `6.0.19` in `frontend` followed by `npm run desktop build` (Rule 48), replacing the ephemeral in-place patch.

## v6.0.18 <sup>30.05.2026</sup>

Patch release fixing a regression introduced by v6.0.17's own CLI refactor: `npm run desktop` (and every other invocation through the `node_modules/.bin/meteor-desktop` symlink) silently did nothing — exit 0, no banner, no Electron. v6.0.17 guarded the top-level `program.parse` behind a main-check `import.meta.url === pathToFileURL(process.argv[1]).href` (the "test seam" refactor). Under ESM, when the entry is reached through a symlink, Node sets `import.meta.url` to the **resolved realpath** of the file but leaves `process.argv[1]` as the **symlink path** on the command line — so the two URLs never match, `isMain` is `false`, and the entire `addOptions`/`registerCommands`/`program.parse` block is skipped. Because npm always invokes bins via the `.bin` symlink, the CLI became a no-op for the primary consumer (`frontend`'s `npm run desktop`). v6.0.17's Rule 48 consumer exercise ran `lib/bin/cli.js` by its **realpath** (`isMain` true), never through the symlink, which is exactly why the mismatch shipped undetected.

### Bug Fixes

* **Make the main-check symlink-safe (`lib/bin/cli.js`).** Replaced the raw URL compare with a realpath compare: `const isMain = fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);`. `fs.realpathSync` resolves the `.bin` symlink in `process.argv[1]` to the same real path `import.meta.url` already reports, so the guard is `true` for both symlink and realpath invocations while still being `false` when the module is `import`-ed (test seam preserved — `addOptions`/`registerCommands`/`actions` remain importable without triggering `program.parse`). Dropped the now-unused `pathToFileURL` from the `url` import.

### Verification (Rule 48)

* **Real-binary consumer exercise through the failing path.** Ran the actual `.bin` symlink (`./node_modules/.bin/meteor-desktop --remote-debugging-port=9333 …`) in `frontend` — pre-fix: zero output, exit 0; post-fix: `METEOR-DESKTOP v6.0.18` banner followed by `electronApp: scaffolding`, i.e. the guard now executes. `node --check` parse-clean on the changed file; `eslint lib/bin/cli.js` clean. Consumer confirmed end-to-end: `frontend` `npm run desktop` builds and launches Electron again.

### Regression coverage (Rules 35, 41)

* `tests/unit/cli.test.js` imports `addOptions`/`registerCommands` directly and so bypasses the `isMain` guard — it structurally cannot catch a symlink-main regression. Added `tests/functional/cli-bin.test.js`, which spawns the bin through a `node_modules/.bin`-style symlink and asserts `--version` prints; inversion-checked (reintroducing the symlink mismatch makes it fail with empty stdout). A `prepublishOnly` smoke gate (`scripts/prepublish-smoke.js`) runs the same symlink invocation so a no-op CLI can never be published. Closes seed `meteor-desktop-4e12`.

## v6.0.17 <sup>30.05.2026</sup>

Patch release fixing a latent CLI argv-routing bug (`lib/bin/cli.js`, present since the 2016 initial commit `b6b10cc`) that produced the poisoned `ROOT_URL=build/` the v6.0.15 A2.6 gate now catches (seed `meteor-desktop-e7c2`). The CLI used a hand-rolled "prefix-rewriter" that decided whether a subcommand was given by substring-checking **only `process.argv[2]`** against a known-commands string. When global options preceded the subcommand — `meteor-desktop --build-meteor --production --meteor-settings X build …` — `argv[2]` was `--build-meteor` (not a known command), so the rewriter injected `run` ahead of everything and re-parsed. Commander then matched `run [ddp_url]`, consumed the options, and the user's intended `build` positional became `run`'s `ddp_url`. `getDdpUrl('build')` short-circuited (truthy) and returned `'build'` unchanged, writing `ROOT_URL=build/` and `DDP_DEFAULT_CONNECTION_URL=build/` into the staged `index.html`. Pre-A2.6 this shipped silently and surfaced at runtime as `net::ERR_NAME_NOT_RESOLVED` on `/sockjs/info` (seed `e2e-4193`).

### Bug Fixes

* **Replace the manual argv prefix-rewriter with commander's native default command (`lib/bin/cli.js`).** Removed the `process.argv[2]`-based rewriter block and the now-dead `cmd` const; registered `run` with `{ isDefault: true }` so an invocation supplying no subcommand token (regardless of where global options appear) dispatches `run`, while a real subcommand token (`build`, `package`, …) is matched natively at any argv position. Removing the rewriter alone fixes the options-before-subcommand mis-routing (commander finds the `build` token wherever it sits); `isDefault` preserves the prior "no subcommand → run" and "bare ddp_url → run" behaviours. Net effect on the seed repro: `meteor-desktop --build-meteor --production --meteor-settings X build` now dispatches **build** with `ddp_url=undefined` → `getDdpUrl` returns `http://127.0.0.1:3000` → A2.6 passes.

### Refactor (test seam)

* **Extract `addOptions(prog)` and `registerCommands(prog, handlers)` from `lib/bin/cli.js`, export them plus the `actions` map, and guard the top-level `program.parse` behind an `import.meta.url`/`process.argv[1]` main-check.** This lets tests build a fresh `Command`, inject spy handlers, and assert argv→action routing without running build work. `getDdpUrl`, `meteorDesktopFactory`, and all action bodies still read the commander singleton `program.opts()` — zero blast radius on the build pipeline.

### Tests (Rules 16, 35, 41)

* New `tests/unit/cli.test.js`: a `route(args)` helper parses argv tails through the real option+command graph with spy handlers and asserts dispatch. Covers the seed repro (`<options> build` → build/undefined), the current frontend build-first invocation, no-args → run, `run --debug` → run, bare `build` → build, bare ddp_url → run with that url, and `init-tests-support`. **Inversion check (Rule 41):** dropping `{ isDefault: true }` makes the no-args and bare-ddp-url cases fail (commander has no default command); the seed-repro case is guarded by the rewriter removal — both mechanisms are load-bearing and test-locked. 7 passing.

### Verification (Rules 47, 48)

* `npx eslint lib/bin/cli.js tests/unit/cli.test.js` — clean (typescript installed transiently with `--no-save` to make the airbnb/typescript-eslint config loadable; `package.json` untouched).
* Full unit suite: 95 passing, 1 pre-existing unrelated failure (`meteorApp #validateHashCoherence stylesheet links`, reproduced on a clean tree — filed as a separate seed).
* **Real-binary consumer exercise (Rule 48), differential, non-destructive:** ran the actual `lib/bin/cli.js` (the file `frontend`'s `meteor-desktop` bin symlinks to) with the seed's options-first argv in a throwaway non-Meteor dir. Fixed build logs `no ddp_url specified, setting default: http://127.0.0.1:3000` (→ `getDdpUrl` received `undefined`, not poisoned) before the `not in a meteor app dir` exit; the master (buggy) build omits that line (→ `ddpUrl='build'`). The full `npm run desktop build` was not run to avoid wiping the dev app's `.meteor/desktop-build` and killing running Electrons (Rule 28); the routing the fix changes is fully resolved before any build artifact exists, and is exercised by the run above.

## v6.0.16 <sup>26.05.2026</sup>

Patch release fixing a v6.0.15 regression that broke `npm run desktop` (dev mode) for every consumer whose inner Meteor was started without `--server`. The A2.6 runtime-config URL gate added in v6.0.15 (`lib/meteorApp.js:~2264 validateRuntimeConfigUrls()`) required both `ROOT_URL` and `DDP_DEFAULT_CONNECTION_URL` to be present-and-valid strings in the serialised `__meteor_runtime_config__`, but Meteor legitimately omits the `DDP_DEFAULT_CONNECTION_URL` key from the JSON in dev mode (no `--server` argument supplied to `meteor run`), and the runtime recovery layer at `skeleton/app.js:953-960` sets it at request time. The over-strict gate aborted the build with `A2.6 runtime-config URL gate failed: DDP_DEFAULT_CONNECTION_URL is missing or empty` and a misleading "leftover meteor-desktop or rspack watcher" hint. Direct observation of the live-served HTML at `http://localhost:3000/` after a clean `npm start` in frontend confirms the absence: 1 `__meteor_runtime_config__` block, `ROOT_URL=http://localhost:3000/`, `DDP_DEFAULT_CONNECTION_URL` key not present in the parsed JSON.

### Bug Fixes

* **A2.6: tolerate `DDP_DEFAULT_CONNECTION_URL` absence when `--ddpUrl` is null (`lib/meteorApp.js:~2273 validateRuntimeConfigUrls()`).** Split the per-key validation so absence is OK for dev mode where the runtime recovery layer (`skeleton/app.js:953-960`, comment: *"Belt-and-suspenders … cases where the keys were absent from the serialised config JSON"*) sets the value at request time. `ROOT_URL` remains structurally required regardless of `--ddpUrl` (Meteor always emits it; absence indicates a real defect). When `--ddpUrl` is supplied (`--build-meteor` path), both keys still must be present and exactly match the configured ddpUrl — `updateDdpUrl@806-807` writes both, so a mismatch means the rewrite was incomplete. Hostname-is-`'build'` poisoning still fails the gate hard even when `--ddpUrl` is null — absence-is-OK is not poison-is-OK.

* **A2.6: scope the watcher-contention hint to hostname-`'build'` failures only.** The v6.0.15 gate appended the *"Likely cause: meteor-desktop's inner 'meteor run' was contended by a leftover meteor-desktop or rspack watcher"* hint to every failure reason, sending operators down the wrong investigation path when the actual cause was a URL parse error, a key mismatch, or a missing key. The hint is now gated on the seed-e2e-4193 failure mode (URL hostname equals `'build'`). Mismatch, parse, and absence failures emit the diagnostic block without the misleading hint.

### Rationale (Rule 6 — defensive code without proving the state was an error)

The v6.0.15 gate treated `DDP_DEFAULT_CONNECTION_URL` absence as a hard error without tracing whether the absent state could arise in legitimate runtime behaviour. It can, and it does: dev-mode `meteor run` without `--server` emits a runtime config where the key is structurally omitted (not present-but-undefined), and the renderer-side `skeleton/app.js:953-960` script unconditionally sets both keys at request time. The corrected gate now matches the actual contract: `ROOT_URL` is structurally required (Meteor always emits it); `DDP_DEFAULT_CONNECTION_URL` is required only when `--ddpUrl` was explicitly supplied (which forces `updateDdpUrl` to write both).

### Tests (Rules 38, 50)

`tests/unit/meteorApp.test.js` `#validateRuntimeConfigUrls`: replaced the v6.0.15 happy-path dev-mode test so its fixture mirrors the real shape captured from the live-served `index.html` (no `DDP_DEFAULT_CONNECTION_URL` key in the parsed JSON, only `meteorRelease`, `gitCommitHash`, `ROOT_URL`, `ROOT_URL_PATH_PREFIX`, `appId`, `isModern`, etc.) instead of the v6.0.15 synthetic fixture that included both keys. Added three new tests: (1) `--ddpUrl` is set but DDP key absent → fails (production-path post-condition of `updateDdpUrl`, no watcher hint); (2) DDP key has `hostname=='build'` even when `--ddpUrl` is null → fails with watcher hint (absence-is-OK is not poison-is-OK); (3) `ROOT_URL` absent entirely → fails (structurally required, no watcher hint). Strengthened the existing mismatch test to assert the watcher hint is suppressed; strengthened the existing DDP-hostname-is-`build` test to assert the watcher hint is present. Total: 6 → 9 tests.

### Verification

1. `npx mocha tests/unit/meteorApp.test.js --grep validateRuntimeConfigUrls` — **9/9 pass**.
2. **Inversion check per Rule 44**: temporarily replaced `if (expectedUrl !== null)` with `if (true)` (forcing DDP absence to always fail) — the new dev-mode happy-path test failed with `expected [Function] to not throw an error but 'Error: A2.6 runtime-config URL gate f…' was thrown`, all 8 other tests still passed; reverted. Temporarily replaced `isBuildPlaceholder` with `(isBuildPlaceholder || true)` (forcing the watcher hint to always emit) — the three "no watcher hint" tests failed with `expected Error… not to match /meteor-desktop or rspack watcher/`, all 6 other tests still passed; reverted.
3. **Real-input verification (Rule 50)**: reconstructed the exact dev-mode `__meteor_runtime_config__` shape captured from the live-served `frontend/.meteor/desktop-build/meteor/index.html` (URL-encoded JSON containing `ROOT_URL=http://localhost:3000/` and NO `DDP_DEFAULT_CONNECTION_URL` key) and ran `validateRuntimeConfigUrls()` against it directly via a Node REPL. Result: `INFO A2.6: runtime-config URLs OK (ROOT_URL=http://localhost:3000/)` — the gate now PASSES the exact data that broke v6.0.15.
4. **Consumer-end exercise: `npm run desktop` (dev) per Rule 52** — linked the local meteor-desktop into frontend via `npm link` (homebrew global prefix → symlink → `frontend/node_modules/@a4xrbj1/meteor-desktop`), started `meteor npm start` in frontend (full chain: rspack on 8091 + meteor on 3000), confirmed the live-served `http://localhost:3000/` returns a 15-KB index.html with `DDP_DEFAULT_CONNECTION_URL` key absent and `ROOT_URL=http://localhost:3000/`. Ran `meteor npm run desktop -- --remote-debugging-port=9333`. **A7 build summary: A4 desktop.asar content, A2 bundle structure, A2.5 hash coherence, injectIsDesktop, A2.6 runtime-config URLs, A3 meteor asar, A3.5 manifest-asset coherence — all gates passed including A2.6.** Electron launched, BrowserWindow loaded successfully (`[smoke:A6] BrowserWindow loaded successfully (DOM has content)`).
5. **Consumer-end exercise: `npm run desktop build` (prod) per Rule 52 — deferred for unrelated pre-existing reason.** A2.6 correctly fires against a `ROOT_URL=build/` produced by a latent CLI prefix-rewriter bug in `lib/bin/cli.js:275-289` (from initial 2016 upload `b6b10cc`) that mis-parses `meteor-desktop --build-meteor --production --meteor-settings X build --ignore-stderr Y` by injecting `'run'` as the subcommand and routing the user's `'build'` positional to `run`'s `ddp_url` argument. `getDdpUrl('build')` returns `'build'`, `updateDdpUrl` writes both URL fields to `'build/'`, A2.6 fails with `ROOT_URL is not a parseable URL`. This is A2.6 doing exactly what it should — catching a non-deployable ROOT_URL before it gets sealed into asar. The CLI bug is unrelated to this PR and predates A2.6; the same prod-mode invocation in v6.0.15 would have failed at the same gate. Filed as seed `meteor-desktop-e7c2`. Re-verification of prod mode is pending that fix.

### What is intentionally not changed

- `lib/bin/cli.js:275-289` prefix-rewriter — see verification step 5 above; tracked in seed `meteor-desktop-e7c2`.
- The A2.6 gate's wiring in `build()` (`lib/meteorApp.js:~2197`), the `'A2.6 runtime-config URLs'` gate name in `validationGatesPassed`, and the e2e downstream check at `e2e/global-setup.js:212-243` — untouched; the v6.0.15 contract is unchanged for the seed e2e-4193 case.
- `acquireIndex()`, `changeDdpUrl()`, `updateDdpUrl()`, `packToAsar()`, `validateMeteorAsar()` — untouched.

## v6.0.15 <sup>26.05.2026</sup>

Adds A2.6 — a new validation gate that runs between `changeDdpUrl()` and `packToAsar()` (`lib/meteorApp.js:~2237`) and refuses to seal a `meteor.asar` whose `__meteor_runtime_config__` ships with a non-deployable `ROOT_URL` / `DDP_DEFAULT_CONNECTION_URL`. Filed upstream by frontend seed `e2e-4193` after a production-bound build silently shipped Meteor's `http://build/` placeholder as ROOT_URL: meteor-desktop's inner `meteor run` (`lib/meteorApp.js:476-505 acquireIndex()`) raced with a leftover meteor-desktop / rspack watcher from a prior incomplete build, the fetched index.html came back with Meteor's "no `--server` provided" placeholder, and at runtime the renderer's sockjs client failed with `GET http://build/sockjs/info net::ERR_NAME_NOT_RESOLVED`. A downstream mitigation already existed in `e2e/global-setup.js:212-243` (reads packed asar bytes, refuses to launch Electron when the baked ROOT_URL host is not `localhost` / `127.0.0.1`) — A2.6 is the upstream counterpart that fails the build itself, so consumers that don't run the e2e harness are equally protected.

### Bug Fixes

* **A2.6 runtime-config URL gate (`lib/meteorApp.js:~2237 validateRuntimeConfigUrls()` + wiring in `build()` ~line 2196).** After `changeDdpUrl()` and before `packToAsar()`, re-reads the staged `electronApp.meteorAppIndex`, extracts `__meteor_runtime_config__` via the existing `this.matcher` regex (`lib/meteorApp.js:210`), decodes + JSON-parses it, and for both `ROOT_URL` and `DDP_DEFAULT_CONNECTION_URL` asserts the value is a parseable URL whose hostname is not `'build'`. When `--ddpUrl` was supplied, additionally asserts both values exactly equal the configured ddpUrl (trailing-slash normalised the same way `updateDdpUrl@802-803` normalises). On failure, throws with a Rule 27-compliant diagnostic message naming both URL values, the on-disk index.html path, the configured `--ddpUrl`, and the watcher-contention root cause hinted by the seed. Passes are logged at info level (`A2.6: runtime-config URLs OK (...)`) and `'A2.6 runtime-config URLs'` is appended to `electronApp.validationGatesPassed` so it appears in `A7 build summary`.

### Covered slip paths (Rule 35 — idempotency / coverage audit)

The gate catches three distinct ways `meteor.asar` can have ended up with a poisoned ROOT_URL despite `changeDdpUrl()` appearing to succeed:

1. **`ddpUrl === null`** — `changeDdpUrl()` early-returns silently (`lib/meteorApp.js:2226-2235`), so whatever the inner meteor served is whatever ships. If the inner server was contended, that's `http://build/`.
2. **Multiple `__meteor_runtime_config__` assignments in HTML** — `updateDdpUrl@809-811` uses `content.replace(this.replacer, ...)` without a `/g` flag, so only the first occurrence is rewritten; a second assignment (injected by a Meteor package, an extension, or a malformed inner-server response) keeps the placeholder.
3. **`matcher` regex didn't recognise the runtime-config encoding** — already throws loudly today at `updateDdpUrl@791-793`; A2.6 strengthens this by re-asserting the same invariant even when `ddpUrl === null` (path 1 above) so the assertion is contract-uniform regardless of CLI flags.

### Rationale (Rule 32 — when adding a mechanism, retire what it replaces)

A2.6 and `e2e/global-setup.js:212-243` enforce the same invariant — "the packed `meteor.asar` must ship with a deployable `ROOT_URL`" — but cover non-identical surfaces, so both layers coexist:
- **A2.6** covers every asar produced through `MeteorApp.build()` in `@a4xrbj1/meteor-desktop ≥ 6.0.15`. It fails at build time (no asar produced) and gives the consumer the seed-referenced root-cause hint.
- **`e2e/global-setup.js`** covers asars produced by older meteor-desktop versions, manual `@electron/asar` invocations, downloaded prebuilt asars, and any other path outside `MeteorApp.build()`. It fails at e2e launch time (asar exists but Electron is never spawned).

Neither replaces the other: removing A2.6 would re-expose the bug to all consumers without the e2e harness; removing the e2e gate would let an asar from an older meteor-desktop version slip past the e2e suite. Both gates name the seed and the contention root cause in their failure messages so a future operator can trace the failure to the correct upstream code.

### What is intentionally not changed

- `acquireIndex()` (`lib/meteorApp.js:476-505`) — the inner-meteor contention root cause is out of scope (the seed asks for a gate, not a fix to the race). A2.6 is the gate.
- `updateDdpUrl()` / `changeDdpUrl()` / `packToAsar()` — the rewrite logic is correct as-is; the v6.0.14 gap was the missing post-condition verification, which A2.6 supplies.
- `validateMeteorAsar()` (`lib/meteorApp.js:~2265 A3`) — A2.6 runs against on-disk `meteorAppIndex` BEFORE `packToAsar`, matching the seed's "gate `packToAsar`" fix direction. Re-checking inside the packed asar would be redundant because `packToAsar` is a pure copy (`asar.createPackage`) — no transform applies between A2.6 and the asar bytes.

### Verification

`npx mocha tests/unit/meteorApp.test.js --grep validateRuntimeConfigUrls` — 6 new unit tests pass (happy paths with configured + null ddpUrl, the e2e-4193 ROOT_URL failure mode, an analogous DDP_DEFAULT_CONNECTION_URL failure mode, the multi-assignment regex-miss scenario where ROOT_URL doesn't match the configured ddpUrl, and the missing-runtime-config scenario). Each "throws" test was inversion-checked per Rule 44 by temporarily editing `'build'` → `'buildx'` in `validateRuntimeConfigUrls()` and confirming the two hostname tests fail with the expected message-shape mismatch before reverting. The pre-existing `validateHashCoherence stylesheet links: throws when every stylesheet link is unresolvable` failure on master is unrelated and was confirmed to pre-date this change via `git stash` cross-check.

## v6.0.14 <sup>25.05.2026</sup>

Patch release fixing three sibling validation gates that all enforced the same on-disk invariant for stylesheet `<link>` hrefs, blocking every `skipMobileBuild` (i.e. `npm run desktop` / `npm run desktop-debug`) build whose served `<link rel="stylesheet">` pointed at an rspack-dev-server-only path. The runtime AssetHandler at `skeleton/app.js:770-779` already proxies `/build-chunks-*/*` and `/__rspack__/*` requests to the running dev server (which 307-redirects them to rspack-dev-server's in-memory bundle) — so the on-disk miss is by design, not a packaging bug, and the gates should mirror the same dev-mode tolerance A3.5 already grants to the `__rspack__/client-rspack.js` HMR placeholder (~line 2440) and to `build-chunks*/*.css` containing HTML (~line 2502). Surfaced from frontend seed `e2e-773b` after the v6.0.13 A2.5 hardening hit the dev-mode case head-on: rebuilding with `npm run desktop` aborted with `A2.5: every <link rel="stylesheet"> in index.html is unresolvable — refusing to package a style-less desktop build: /build-chunks-local/main.css`, even though the same URL resolves with full CSS content (`HTTP 200 / 312 KB`) at runtime via the dev-server proxy.

### Bug Fixes

* **Demote A2.5's "every stylesheet is unresolvable" throw to a warning when `skipMobileBuild=true` (`lib/meteorApp.js:~1138`).** Every entry that reaches `cssLinksToPrune` has already passed the `rspackCssUrlRe` filter at line 1109, so in dev mode they are guaranteed to be the runtime-resolvable rspack pattern. The patch keeps the links in `index.html` (no pruning) and logs the dev-mode pass at warn level so the build proceeds. Production behaviour (`skipMobileBuild=false`) is unchanged — the gate still throws on a fully unresolvable manifest, protecting `--build-meteor` builds from packing a style-less asar.
* **Allow rspack-pattern hrefs in `injectEsm`'s `<link href>` validator (`lib/meteorApp.js:~2001`).** The second-layer check that demands every link href resolve to a disk file (added in the v6.0.x A3.5 lineage to guard against post-A2.5 drift) was throwing immediately after A2.5's dev-mode pass with `injectEsm: 1 script/link asset(s) missing on disk after A2.5 hash coherence gate — cannot proceed`. The patch skips the disk check for `/build-chunks-*/*` and `/__rspack__/*` paths in `skipMobileBuild` mode, citing the same runtime-proxy mechanism as A2.5. The script-src side of the same loop already grants `/__rspack__/` unconditionally at line 1966 — this brings the link-href side to parity.
* **Allow rspack-pattern hrefs in A3.5 Check 1 manifest coverage (`lib/meteorApp.js:~2402`).** The dev-server-only `<link href="/build-chunks-local/main.css">` is by design not in `program.json`'s manifest (rspack-dev-server emits CSS to memory; no `entry.url` is registered with `where: 'client'`), so the third gate would have thrown `A3.5: index.html references N asset(s) not in program.json manifest (runtime AssetHandler will fail)` right after `injectEsm` passed. The patch skips the manifest check in `skipMobileBuild` mode for the same two URL patterns. The runtime AssetHandler bypasses manifest lookup for these paths anyway, so the dev-mode skip introduces no runtime regression.

### Rationale (Rule 32 — when adding a mechanism, retire what it replaces)

All three gates encode the same invariant: *every stylesheet link in the packed `index.html` must resolve to a packaged asset*. The invariant is correct in production but wrong in `skipMobileBuild` mode, where the running rspack-dev-server is the source of truth and the asar serves the wrapper only. v6.0.13 caught the first gate hard against this case; v6.0.14 brings all three to the same dev-mode-aware position so a fix to one is not silently undone by the next two downstream. Each patch's comment cites `skeleton/app.js:770-779`, the runtime mechanism that makes the link resolvable, so a future reader can re-verify the claim rather than infer it.

### Verification

Frontend dev-build flow exercised end-to-end against this release: `npm run desktop -- --remote-debugging-port=9333` builds the asar, all six validation gates pass (`A7 build summary: A4 desktop.asar content, A2 bundle structure, A2.5 hash coherence, injectIsDesktop, A3 meteor asar, A3.5 manifest-asset coherence`), Electron launches, and the rendered page inspected directly via the DevTools `Runtime.evaluate` (`ws://127.0.0.1:9333`) reports `document.styleSheets.length === 2`, the main stylesheet contains 93 parsed CSS rules, `<link>` tags resolve to `meteor://desktop/build-chunks-local/main.css` and a code-split chunk, the computed body font is the brand `Atkinson Hyperlegible Next`, the body has 90 children, and the `h1` reads "Automated hints can help you discover your common ancestors" — i.e. the page renders with full Tailwind styling sourced from rspack-dev-server through the AssetHandler proxy.

## v6.0.13 <sup>21.05.2026</sup>

Patch release removing three dependencies that have **zero imports anywhere** in the meteor-desktop repo: `cacache`, `typescript`, and `@electron/packager`. v6.0.10's "refresh deps to latest" bumped all three to majors (`cacache` 20 → 21, `typescript` 5 → 6, `@electron/packager` 19 → 20) despite their unused status; `cacache@21` then pulled in `engines.node: '^22.22.2 || ^24.15.0 || >=26.0.0'`, producing `EBADENGINE` warnings on Meteor 3.4's bundled Node 22.22.1 in every downstream consumer install (the warning is harmless because cacache is unused, but unnecessary noise that confused the v6.0.12 verification run).

### Maintenance

* **Drop unused `cacache` from `dependencies`.** Verified zero imports across `lib/`, `skeleton/`, `scaffold/`, `scripts/`, and `tests/` via `grep -rn cacache --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.json'`. Only reference outside `node_modules/` was the `package.json` declaration itself.
* **Drop unused `typescript` from `devDependencies`.** No `.ts` files, no `tsconfig*`, no `typescript` imports — verified by `find . -name '*.ts'` and `grep -rn typescript --include='*.js'`. `@types/fs-extra` (kept) is a type-only artifact and does not require the typescript compiler.
* **Drop unused `@electron/packager` from `devDependencies`.** The active electron-packager wiring is `lib/packager.js#L20`, which fetches `electron-packager@17.1.2` via `lib/index.js#getDependency` at runtime against the user's project. The devDep at the workspace level was never imported.

## v6.0.12 <sup>21.05.2026</sup>

Patch release fixing a latent argument-order bug in `MeteorApp#buildMobileTarget` that silently undid v6.0.4's `NODE_ENV=production` override (seed `meteor-desktop-7691`). Surfaced as an A3.5 Check 3 abort during the v6.0.11 frontend verification build: rspack wrote its prod output to `_build-local-desktop/main-dev/` instead of `main-prod/`, and the scraper packed the 923-byte HMR placeholder for `__rspack__/client-rspack.js`.

### Bug Fixes

* **Reverse `Object.assign` order when composing the spawned Meteor env (`lib/meteorApp.js:624`).** `Object.assign(env, process.env)` overwrites our explicit overrides with whatever the parent shell exposes; for a fresh shell with `NODE_ENV` unset, that wipes the `env.NODE_ENV = 'production'` set on line 613, the atmosphere `@meteorjs/rspack` plugin sees `Meteor.isDevelopment === true`, and the entire production build goes through the dev-mode resolver. The corrected merge `Object.assign({}, process.env, env)` inherits the parent environment but lets the explicit `METEOR_PRETTY_OUTPUT=0`, `METEOR_NO_RELEASE_CHECK=1`, `NODE_ENV=production` and `METEOR_DESKOP_PROD_DEBUG` overrides win as intended. Bug latent since 2018 (`e105f22`); v6.0.4 added the `NODE_ENV` statement believing the merge order placed `env` after `process.env`. The fix only stays silent in shells where `NODE_ENV=production` is already set (e.g. CI matrices), which is why it survived for so long.

## v6.0.11 <sup>21.05.2026</sup>

Patch release relaxing the `app-builder-lib` peer chain that forced every meteor-desktop consumer to install with `--legacy-peer-deps` (seed `meteor-desktop-e286`, surfaced from frontend seed `frontend-d64e`).

### Bug Fixes

* **Narrow `app-builder-lib` and `electron-builder` peerDep ranges from `*` to `^26.9.0`.** Every released `app-builder-lib@26.x` declares its sibling peers `electron-builder-squirrel-windows` and `dmg-builder` as a strict-equal version (`{ "electron-builder-squirrel-windows": "26.X.Y" }` for each X.Y from 26.7.0 through 26.11.0 — verified via `npm view app-builder-lib@<v> peerDependencies`). With meteor-desktop's previous `app-builder-lib: '*'` peer, npm was free to resolve `app-builder-lib` to its `latest` dist-tag (26.8.1) while the consumer's own `electron-builder-squirrel-windows: ^26.9.0` range resolved to 26.11.0, producing `ERESOLVE` on every fresh install. The new `^26.9.0` floor excludes the broken sub-26.9 versions from npm's resolution space; npm picks the highest version satisfying both meteor-desktop's range and the consumer's electron-builder-squirrel-windows range (currently 26.11.0), and the strict-equal peer is satisfied because both sides converge on the same number. Consumers on `electron-builder@<26.9.0` were already in the broken zone; the new floor makes the requirement explicit rather than introducing a regression.
* **Bump `lib/defaultDependencies.js` `electron-builder` / `app-builder-lib` fallbacks from 26.8.2 to 26.9.0.** `lib/index.js#getDependency` auto-installs these versions when the consumer's `package.json` doesn't declare them. Keeping the fallbacks below the new peer floor would have meant the auto-install path would itself fail meteor-desktop's own peer constraint.

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
