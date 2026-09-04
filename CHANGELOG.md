## Unreleased

### Fixed

* **One failed asset no longer discards the whole HCP bundle** (seed `meteor-desktop-686f`). `assetBundleDownloader.js` called `didFail` on the first asset that errored or returned a non-success status, and `didFail` cancels the download. The consumer is gated on `onNewVersionReady`, which a failed download never fires, so the app stayed on its baked bundle and the user was told nothing — and the same full download was attempted again on the next launch, and the next. With ~200 assets per bundle, one transient failure somewhere in the set is close to certain over time, and each one threw away every correctly downloaded megabyte alongside it. This is the amplifier that turned `frontend-1343` from a bandwidth problem into a months-long outage of the HCP channel.
  * **Transient failures are now retried per asset**, three times at 500/1000/2000 ms: a 5xx, a 408, a 429, or a socket error (`TypeError: terminated`, `socket hang up`). At most 3.5 s of extra wall clock per asset, well inside the 300 s stall watchdog in `assetBundleManager.js` — which is re-armed on every *completed* asset, so a retrying neighbour does not consume it.
  * **Terminal failures still fail fast, deliberately.** A 404, a 403, an sri mismatch, a runtime-config mismatch: the server's answer will not change, so retrying only delays a failure that is already correct. Retrying every status would cost seconds per asset on a genuinely broken bundle for nothing.
  * **The status is classified before the body is read** (adversarial review finding P2). A server shedding load can send 503 headers and then stall streaming its error body; awaiting `arrayBuffer()` first would hang there until the stall watchdog killed the bundle, which is exactly the case the retry exists for. `verifyResponse` rejects every non-200 on the status alone, so a rejected response's body is never read at all.
  * **A refused response's connection is released, not leaked** (adversarial review finding P1, the direct consequence of P2). undici holds a connection open until the response body is consumed *or* cancelled, so skipping the read without cancelling would pin one socket per shed asset and the retries would then queue behind them until the stall watchdog failed the bundle — reintroducing the very failure the early return removes. The body stream is cancelled fire-and-forget.
  * **The exhausted failure now says so.** The cause reported through `didFail` → `onError` → `notifyError` → the renderer's `error` event carries `(gave up after 4 attempts)`, so a bundle that will never succeed is distinguishable in the log from one that failed once.
  * **No per-asset request timeout was added, and that is a decision, not an oversight.** `AbortSignal.timeout` measures total elapsed time, not idle time, so the 30 s `hcpRequestTimeout` used for the (small) manifest would abort a legitimate multi-megabyte asset on a slow link. A hung socket is still caught by the 300 s stall watchdog.
  * **Exercised through the real consumer** (Rule 48), not only in unit tests. The working-tree skeleton was installed into `frontend/node_modules/@a4xrbj1/meteor-desktop`, `npm run desktop build` produced a packaged app whose `app.asar` was byte-verified to contain the change, and `e2e/tests/electron-hcp-download-progress.spec.js` ran green (52.7s): a packaged Electron shell fetched a real 207-entry manifest off a real Meteor server and pulled real bytes through the changed path — progress advanced 696 → 4831 → 48798 of 537099 — before exiting on the harness's deliberate `verifyRuntimeConfig` rejection. **What that does NOT cover:** every asset returned 200, so the retry branch itself never executed there. Its coverage is the unit tests above. The injected skeleton was restored to the published 8.0.3 afterwards and the `.e2e-build-commit` marker deleted, so no later run can reuse a build made from unpublished code.
  * Six tests drive the real `resume()` through a real `Queue`, including one that writes a real file to a temp dir to prove the bundle *completes* after a transient 503. Three inversions run and observed: `maxAssetRetries` to 0 turns three of the six red (the 404 test correctly stays green, which is its point); reading the body unconditionally hangs the stalled-503 test; dropping the `cancel()` call drops the release count to 0. 327 passing, eslint and tsc clean.

* **A network drop during an HCP download no longer crashes the main process** (seed `meteor-desktop-4d13`). Both HCP requests sent `Connection: close` — `assetBundleDownloader.js` per asset and `assetBundleManager.js` for the manifest. A close-delimited response leaves undici's parser with `shouldKeepAlive` false, and that flag is the sole gate on all three of its `parser.finish()` call sites (`client-h1.js` `onHttpSocketError`, `onHttpSocketEnd`, `onHttpSocketClose`). `finish()` opens with `assert(!this.paused)`, and the parser IS paused whenever llhttp returned `PAUSED` on body backpressure — routine on a multi-MB asset. So a socket dying mid-body threw an `AssertionError` from inside the socket's own `error` listener, **outside** the fetch promise chain, where the existing `.catch(onFailure)` could not see it. It reached the process as an `uncaughtException`; in a consumer that installs its own handler this surfaces to the user as an application-crash dialog. The header is removed from both requests.
  * **Measured on a real customer's Windows client, 2026-09-03** (app 5.3.0, skeleton 6.0.30, win32 10.0.26200), not deduced from a test. The uploaded `run.log` ends with `started downloading asset bundle (5478230 bytes)`, then `error querying asset manifest ...: fetch failed` and `error downloading asset: packages/modules.js: TypeError: terminated`, and the crash report carries `AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: assert(!this.paused) at Parser.finish (node:internal/deps/undici/undici:7380:9) at TLSSocket.onHttpSocketError`. The app was up and in use at the time, so this is not a startup failure.
  * **The header bought nothing.** Nothing in this repo documents why it was there; it arrived wholesale in release commit `e67b766` (4.0.2). Keep-alive is the HTTP/1.1 default and is what the renderer already uses for these same assets, and seed `meteor-desktop-3669` measured production serving 151-way and 285-way concurrent bursts of this exact request shape.
  * **This narrows the window, it does not seal it.** `shouldKeepAlive` also goes false when the *server* elects to close — Node's `keepAliveTimeout`, `maxRequestsPerSocket`, an ingress recycling a connection — so the assertion path remains reachable, just rarely, instead of on every single response. Closing it entirely needs a fix in undici, not here.
  * Both call sites are pinned by a test asserting the absence of the header, each inversion-verified: restoring `Connection: 'close'` fails exactly that test in each file. 321 passing, eslint and tsc clean.

## v8.0.3 <sup>01.09.2026</sup>

### Fixed

* **A leftover directory under a version's name no longer wedges HCP on that version for good** (seed `meteor-desktop-e93c`). `moveDownloadedAssetBundleIntoPlace` (`skeleton/modules/autoupdate/assetBundleManager.js`) renamed the finished `Downloading` directory onto `versions/<version>` with no check that the target was free. `rename` onto a non-empty directory throws — `ENOTEMPTY` on POSIX, `EPERM`/`EEXIST` on Windows *even when the target is empty* — and while the throw is caught by the downloader's success callback and reported through `didFail`, nothing ever cleared the leftover. So every subsequent check re-downloaded the entire bundle and died on the same line. The target is now removed when it exists.
  * **Two producers put a leftover there, both in the same file.** `loadDownloadedAssetBundles` catches a bundle that will not construct, logs `broken version in directory`, and leaves the directory on disk *without registering it* — and unregistered is exactly what makes `shouldDownloadBundleForManifest` willing to fetch that version again. Separately, a prune that exhausts `rimrafWithRetries`' five attempts resolves `state: false` yet `removeAllDownloadedAssetBundlesExceptForVersion` still deletes the in-memory record, leaving a half-deleted tree with nothing tracking it.
  * **A pruned version genuinely comes back.** The version is a content hash, so a deploy rollback re-serves the same string and walks straight into the leftover.
  * **Windows-amplified, which is why it has probably never fired on macOS.** POSIX `unlink` succeeds against open handles; Windows refuses, so a prune blocked by the search indexer, an AV scanner or a still-serving local server fails there — and its characteristic failure shape is the half-deleted tree above. This was found by a source audit of the HCP path for POSIX-only assumptions, not by a Windows run: **no Windows host was used and the seed's Windows item is not discharged.**
  * **The one whole-store recovery path is now hardened too, and for a stronger reason than hardening blind** (same seed, R2). `initializeAssetBundles` in `autoupdate.js` sweeps the entire versions directory when the *embedded* bundle changed, i.e. on a native update. It used a raw `rmSync` with **no `try`/`catch` at all** — and `init` is registered on the eventsBus as the `beforeDesktopJsLoad` handler (see the constructor), so an uncaught throw there escapes the emit **during startup**, before the desktop JS loads. `force: true` suppresses `ENOENT` only; `EPERM`/`EBUSY` from an open handle still throws, which is the ordinary Windows case, and this sweep runs precisely when the native was just replaced — so the failure would coincide with the newly installed binary. That is a startup crash, not the silent degrade this entry previously recorded. The sweep now catches, logs the real error, and continues.
  * **A survivor is no longer permanent.** `resetConfig()` runs unconditionally after the sweep, nulling `lastDownloadedVersion`, and bundle selection below branches entirely on that — so a directory surviving the sweep is never resurrected, and the R1 guard above clears it before renaming onto it. Verified at source rather than asserted, and the test now pins it explicitly so a future reorder cannot quietly break it (adversarial review finding S1).
  * **A single attempt here too**, for the same reason as R1: this is the Electron main process at startup and Node has no synchronous sleep, so retrying would freeze the window.
  * **Tested with a real `EACCES`, not a mock** — `chmod 0o500` on the versions dir is the POSIX stand-in for the Windows `EPERM`/`EBUSY` this guards. Inversion run: remove the `try`/`catch` and the test goes red; restored byte-identical. 320 passing, eslint and tsc clean.
  * **Deliberately synchronous, and deliberately a single attempt.** The caller's `try`/`catch` is what routes a failure here to `didFail`; an async throw would escape it and `didFinishDownloadingAssetBundle` would run before the move completed. On retries the adversarial review landed a fair hit: an earlier draft of this comment said "retries would buy nothing", which only ruled out a handle held by *this* process while the paragraph above blames *external* lockers for the Windows failures — the justification contradicted its own prose. The internal half is now verified rather than asserted (`localServer.js` serves exactly one `assetBundle` plus that bundle's parent, and this line is reached only for a version that is neither the initial bundle's nor in `downloadedAssetBundlesByVersion`), so an external transient holder is the only possibility left — and it is **accepted, not retried**. Node has no synchronous sleep, so a synchronous retry means busy-waiting the Electron **main** process: a frozen window in exchange for clearing a stale directory a few hundred milliseconds sooner. A locked leftover therefore throws, reaches `didFail`, and the next scheduled check retries the removal. Recovery is deferred by one poll interval, not lost, which is the whole difference from the permanent wedge this removes.
  * **One test, not two, and the reason is stated in the test itself.** The non-empty case inverts cleanly — dropping the guard fails it with `ENOTEMPTY: directory not empty, rename … Downloading -> … newversion`. An *empty*-leftover test was written and then removed: POSIX `rename` onto an empty directory succeeds, so it passed with and without the fix on macOS, which is coverage in appearance only. That divergence belongs to a Windows run, and is recorded in the comment on the guard.
  * **What the audit ruled out**, so the next reader does not redo it: no string-concatenated paths anywhere in the HCP path (all `path.join`/`path.resolve`), no `file://` URL built from a filesystem path, and `localServer.js`'s traversal guard is already case-insensitive, which is the Windows-correct form.

## v8.0.2 <sup>31.08.2026</sup>

### Fixed

* **Every `run.log` record now carries an ISO-8601 `time`** (seed `meteor-desktop-1a97`). `skeleton/loggerManager.js` wrote `{level, message, entity}` and no timestamp, so the file a consumer's telemetry uploads on a crash or a stuck startup — the shell's only record of the window lifecycle and the startup timer — could not answer any duration question at all.
  * **Not a deliberate regression, but a real one.** The winston File transport this logger replaced (seed `meteor-desktop-f570`) emitted a timestamp for free; the rewrite's header enumerates the four things winston was silently losing and fixes all four, and the timestamp is simply not among them. A partly-upgraded install therefore has BOTH halves in one file: measured on a real end-user Windows report, the pre-6.1.0 half is fully timestamped and the post-upgrade half has none.
  * **It cost a real investigation.** `frontend-0144` item (a) — why did the ESC-0005 renderer need more than 60 seconds to start — is a duration question, and it was unanswerable from the one artifact that exists to answer it. Nothing else in the uploaded payload carries per-line time either.
  * **`time` is trailing, for the same reason `entity` is.** The record must stay one line of JSON with `level` first and `message` second, because a consumer greps it with a regex anchored on `"message":"` immediately followed by the message text. ISO-8601 rather than epoch millis so that a human scanning a partly-upgraded file — which holds the old plain-text winston lines and these JSON ones together — sees a date in both halves rather than an opaque integer in one. The two formats are otherwise nothing alike, and this entry previously claimed more similarity than they have.
  * The record-shape test now pins the key ORDER explicitly (`['level', 'message', 'entity', 'time']`) rather than implying it through one string match, so a future field lands in the right place. Inversion run: drop the field and both the shape test and the new timestamp test fail, and only those two.
  * **Exercised against the real consumer, not just this repo's tests** (Rule 48): new-shape records were pushed through `frontend/.desktop/telemetry.js`'s actual `createTelemetry` — noise filtering, download-progress thinning, Windows-path redaction and warn/error retention all behave unchanged, and the timestamps survive into the uploaded body.

* **A failed installer build no longer reports success to the shell** (seed `frontend-4e42`). `InstallerBuilder.build()` wrapped the electron-builder call in a `try/catch` that logged the failure and then resolved. Every layer above it was already correct and every one of them was made inert by that catch: `buildInstaller()` in `lib/index.js` rethrows when asked to, and `lib/bin/cli.js` asks — but its own `try/catch` sat *outside* this one and therefore never saw an error, so `.catch(reportAndExit)` never fired and the process exited `0`. The catch is gone; the failure propagates.
  * **Measured on the first signed `--mac --win` beta run, 2026-08-30.** electron-builder aborted with `InvalidConfigurationError: Cannot find suitable Parallels Desktop virtual machine (Windows 10 is required) and cannot access pwsh and wine locally`, produced no installer, no `beta.yml` and no `beta-mac.yml` — and `frontend`'s `scripts/desktop-beta.sh`, which runs under `set -e`, walked straight past it to the next step.
  * **This is why the `throwError` argument added for seed `meteor-desktop-a8f8` did not close it.** That fix was correct plumbing for the paths it could reach; nobody looked one frame deeper, where a second, unconditional catch outranked it. The answer to the seed's own open question — "either that fix does not cover this path or it regressed" — is that it never covered this path.
  * **Blast radius is one caller.** `lib/index.js:112` is the only invocation of `electronBuilder.build()` in the package (`grep -rn '\.build()' lib/`), and it already wraps the call in a `try/catch`. A caller that invokes `buildInstaller()` without `true` keeps exactly today's behaviour: the error is logged and swallowed there instead.
  * **The `extractedNodeModules` cleanup keeps a catch of its own**, because the one being removed covered it too. Deleting a temp dir is not part of building an installer, and widening failure to include it would have reported a perfectly good installer as a failed build every time that `rmSync` lost a race with a Windows file lock — a live risk here, see `killMSBuild()`/`wait()` in the same file. The first version of this fix missed that and an adversarial review caught it; the CHANGELOG entry it wrote ("the cleanup is unchanged") was true only for the case where `build()` itself throws, where the cleanup was never reached either way.
  * **`buildInstaller()` now rethrows the original error rather than `new Error(e)`** (`lib/index.js`). The wrap stringified the original into a fresh error's message and generated a new stack at that line, discarding the one pointing into electron-builder. Harmless while the catch was unreachable for this failure; it is the operator's only stack now that it is the normal path.
  * Covered by five cases in `tests/unit/electronBuilder.test.js`, driving the real `build()` and the real `buildInstaller()` against a stub electron-builder — third-party, and its observed failure needs a Parallels VM plus an Azure signing identity to reproduce. All three inversions were run, and each reddens only its own case: restore the swallowing catch and the propagation case goes green because the promise resolves; drop the cleanup's own catch and the successful-build case fails; restore `new Error(e)` and the error-identity case fails.
  * **Flagged, not fixed** (seed `meteor-desktop-701d`): a failed build leaves the app's `node_modules` moved aside. `beforeBuild` calls `moveNodeModulesOut()` and only `afterPack` moves them back, so any electron-builder failure between the two strands them in `tmpNodeModules` — which is what left `.meteor/.desktop_node_modules/` behind on the run above.

## v8.0.1 <sup>30.08.2026</sup>

### Fixed

* **The web-HCP bootstrap no longer starts automatic update checks against a loopback `ROOT_URL`** (seed `e2e-5c54`). In a dev `meteor run` or an e2e harness the desktop app is a pinned build talking to a server whose bundle version can never equal the one baked into `meteor.asar`, so every check downloaded a full bundle that the shell's own `verifyRuntimeConfig` then refused — `ROOT_URL in downloaded asset bundle would change current ROOT_URL to localhost`. The served host and the baked `ddp_url` are two different spellings of loopback (`lib/bin/cli.js#getDdpUrl` defaults to `http://127.0.0.1:3000` under `--build-meteor`; Meteor otherwise defaults `ROOT_URL` to `localhost`), so the download was futile by construction. `start()` now skips `requestCheck()` and the 10-minute timer when `window.__meteor_runtime_config__.ROOT_URL` is loopback.
  * **Prod is unaffected.** A release passes an explicit `ddp_url`, which `lib/meteorApp.js:808` writes into `runtimeConfig.ROOT_URL`, so the check reads the real host and returns false. The parse fails **open** — an unreadable or malformed `ROOT_URL` is treated as non-loopback, so a bad read can only leave updates enabled, never disable them.
  * **The one gap, stated rather than papered over**: `verifyRuntimeConfig` (`skeleton/modules/autoupdate/assetBundleDownloader.js:394`) rejects a swap only when the *downloaded* host is the literal string `localhost`, so it does not stop a prod server that advertised `ROOT_URL=http://127.0.0.1:…` from being applied — after which this gate would read loopback and stop future automatic checks. That requires a prod server serving a client-loopback `ROOT_URL`, which breaks every asset and DDP URL in the bundle long before this gate matters. Not created by this change, and it cannot arise for a build made with an explicit `ddp_url`.
  * **`WebAppLocalServer.checkForUpdates()` is deliberately left callable.** Only the automatic trigger is gated. `e2e/tests/electron-hcp-download-progress.spec.js` drives that API directly to exercise the download / blocking-overlay / dismissal path, and it is the only automated coverage that path has; gating the API instead of the timer would have deleted it. This is why the escape-hatch env var the seed originally specified as mandatory is not needed.
  * **The gate is the last two lines of `start()`, not an early return from the top of it.** The three registrations ahead of it run in every environment: without `startupDidComplete()` the shell never records a last-known-good version and loops reset → 5-min timeout → revert forever (the stuck-splash brick, seed `meteor-desktop-hcp-brick`), and `onError` / `onNewVersionReady` would go unregistered.
  * Covered by five cases in `tests/unit/skeleton/desktopHcpBootstrap.test.js` — the three loopback spellings, prod-stays-enabled, and `checkForUpdates()` still working under the gate. Both inversions were run: making the predicate fail open reddens the three loopback cases, forcing it true reddens the prod case. That suite also gains the real `URL` global, which a fresh `vm` context does not provide (ECMAScript intrinsics only), and whose absence silently made the gate fail open inside the sandbox.

## v8.0.0 <sup>30.08.2026</sup>

### Breaking

* **The `package` command and all `electron-packager` support are removed** (seed `meteor-desktop-a493`). `lib/packager.js`, `runPackager()` on the main entity, the `'electron-packager': '17.1.2'` line in `lib/defaultDependencies.js`, the `packagerOptions` key in `scaffold/settings.json` and its `Desktop` JSDoc property, and the now-orphaned `env.paths.packageDir` (`.desktop-package`) all go with it. Use `build-installer`, which drives electron-builder and is what actually produces installers — `builderOptions`, not `packagerOptions`, was already the live surface.
  * **The motivation is a silent dependency re-install.** `lib/index.js#getDependency` auto-installs any name absent from the consumer's `package.json`, at an exact pin, mid-command, with no error. `frontend` removed `electron-packager` on 2026-08-29 to clear two HIGH advisories — the packager's own, and `extract-zip` GHSA-jmr9-qjv8-65gv (unvalidated symlink path traversal, vulnerable range `*`, no forward fix; npm's only suggestion is a major downgrade to 14.2.1) — and a single `npm run desktop -- package` would have put both straight back.
  * **The command could not have worked for anyone.** `runPackager` wrapped the packager in `new Promise((resolve, reject) => this.packager(args, cb))`, but `electron-packager` has been promise-only since v13; 17.1.2's entry point is `module.exports = async function packager (opts)` — one parameter, no callback (verified by unpacking the published tarball). The second argument was ignored, the returned promise dropped, and the outer promise never settled. Worse, `packageApp` renames the consumer's `node_modules` aside *before* the call and renames it back in a `finally` that the never-settling `await` never reaches. So the command hung forever with the app's `node_modules` moved. That is why this removal is breaking on paper only: there is no working usage to break.
  * **`package` is kept as a tombstone that exits `1` with a pointer to `build-installer`, rather than deleted outright.** `run [ddp_url]` is commander's default command, so a removed verb is swallowed as a `ddp_url` and the app launches against a nonsense URL — a refusal reported as success, the exact shape seed `meteor-desktop-a8f8` spent a release removing. A functional test drives the real `.bin` symlink (what `npm run desktop -- package` actually reaches) and asserts the exit code and the message; inversion-checked by deleting the tombstone.
  * `--ia32`'s help text drops its `/package` half. The option stays: `lib/electronBuilder.js` and `lib/electronApp.js` still read it.
  * **Shipped as a MAJOR, decided 2026-08-30.** The alternative was a minor, so that `frontend`'s `^7.0.0` would pick the fix up with no dependant-side diff. Rejected: the release deletes a public CLI command and a public API method, and a version number that says otherwise is a lie told to every consumer to save one line in the only consumer we have. `frontend` is the sole dependant in this workspace (`/usr/bin/grep -rn '"@a4xrbj1/meteor-desktop"' --include=package.json`), so its range moves to `^8.0.0` in the same session as the publish.
  * Not touched: `tests/fixtures/.desktop/settings.json` still carries a `packagerOptions` key. It is inert input to the settings-hash tests, and removing it would move a golden hash for no behavioural gain.

### Changed

* **The recommended dependency pins in `lib/defaultDependencies.js` are refreshed to what a consumer actually runs**: `electron` `42.5.2` → `42.9.3`, `electron-builder` and `app-builder-lib` `26.9.0` → `26.15.3`. All three were stale against `frontend`, and `getDependency` warns on every mismatch, so a real `npm run desktop build` printed three false "be sure to report that when submitting issues" lines per run — measured in the e2e harness's own desktop build on 2026-08-29:
  ```
  WARN  index:  you are using a electron@42.9.3 while the recommended version is 42.5.2, ...
  WARN  index:  you are using a electron-builder@26.15.3 while the recommended version is 26.9.0, ...
  WARN  index:  you are using a app-builder-lib@26.15.3 while the recommended version is 26.9.0, ...
  ```
  * **This is not a version bump of anything installed here.** These values are the pin `getDependency` uses when the name is *absent* from the consumer's `package.json` — see `lib/index.js#getDependency`, which auto-installs at that exact pin. `frontend` declares all three, so nothing about its build changes; what changes is the version a *fresh* consumer receives, and the disappearance of three spurious warnings.
  * Publish dates checked 2026-08-29, all well outside the 7-day quarantine: `electron@42.9.3` 2026-08-18 (11d), `electron-builder@26.15.3` and `app-builder-lib@26.15.3` both 2026-06-09 (81d).
  * Flagged, not fixed (it changes nothing while both values are equal): `lib/electronBuilder.js:52` resolves **app-builder-lib** using `defaultDependencies['electron-builder']` rather than its own key.

## v7.0.0 <sup>28.08.2026</sup>

> **This release also contains everything listed under `v6.1.0` below, which was written but never
> published — the registry went straight from `6.0.30` to `7.0.0`.**

### Breaking

* **`@babel/runtime` is no longer a `dependency`.** It was imported nowhere in `lib/`, `skeleton/`, `scaffold/` or `tests/`, and a real `npm run desktop build` produces asars containing zero references to it — see the entry under *Fixed* for the measurements. A consumer that never declared it itself but relied on receiving it transitively through this package will now fail at **its** runtime, not at install time. Declare it directly if you need it. `@babel/register` and `babel-plugin-istanbul` went with it; both were `devDependencies`, so neither reaches a consumer.
* **`meteor-desktop build` and `run` now exit `1`, not `0`, when the `.desktop` dir is missing or corrupt** (seed `meteor-desktop-a86c`). Any CI step or wrapper script that treated that refusal as success will start failing — which is the point. See *Fixed*.
* **Two dead statics are gone from `DesktopPathResolver`**, which ships inside `skeleton/`: `readInitialAssetBundleVersion()` (seed `meteor-desktop-8577`) and `readJsonFile()` (seed `meteor-desktop-2498`). Both had zero call sites anywhere in this workspace and neither is documented in the README or referenced from `scaffold/`, but no grep can bound the consumers of a published package. An external caller fails loudly at the call site with `is not a function` — though note `readJsonFile` swallowed its own errors (`catch { return {}; }`), so a caller that wrapped it in a `try/catch` of its own would see silence instead.
* **`winston` is no longer installed into consumers' `.meteor/desktop-build`.** `lib/skeletonDependencies.js` decides what every consumer's desktop build gets, and `winston: '3.13.0'` was removed with the logger rewrite (seed `meteor-desktop-f570`, listed under `v6.1.0` below). A `.desktop/` module of your own that imports `winston` directly will no longer resolve it — declare it in your own `.desktop/settings.json` dependencies if you need it. The injected `log` object is unaffected in the surface anything actually calls (`error`/`warn`/`info`/`verbose`/`debug`), but its **winston-shaped** properties are gone: code doing `log.transports.file.level = …` breaks.
* **The CLI now reports failure to the shell, where it previously exited 0** (seed `meteor-desktop-a8f8`). Three separate paths changed, and any script or CI step that treated their exit status as success will start failing: `run` and `just-run` forward Electron's own exit code and report a signal termination as `1`; `not in a meteor app dir` exits `1` instead of `0`; and `build-installer` and `package` no longer swallow their own core failure. Details under *Fixed*.

### Added

* **A JS bundle can require a minimum native version, and HCP refuses it otherwise (seed `meteor-desktop-0a0e`, Stage 3 of `meteor-desktop-e490`).** Native and JS have updated on independent channels since desktopHCP was removed in v6.0.0 — the shell only through a signed `electron-updater` release, the bundle over the air — with nothing checking that the bundle a user receives can actually run on the shell they have. A bundle now declares its floor as `minDesktopVersion`, read from the manifest's top level or, failing that, from `PUBLIC_SETTINGS` (i.e. `Meteor.settings.public.minDesktopVersion`, which a Meteor app can publish with **no server-code change** — verified against the live production `/__browser/manifest.json`, which carries `PUBLIC_SETTINGS` and, being `web.browser` rather than `web.cordova`, carries no `cordovaCompatibilityVersions`). It is compared against `version` in the built `.desktop/settings.json`. Absent on either side, the bundle is accepted, so no existing app changes behaviour.
  * **The comparison is ORDERED, which is a deliberate deviation from the seed.** Seed 0a0e asked for an equality test against the build-time `compatibilityVersion` md5. An md5 has no order, so it cannot tell the dangerous direction (bundle newer than shell) from the safe one (shell newer than bundle) — both are just `!==`. Two consequences the adversarial review demonstrated: a pending bundle would be rejected the moment the native it was fine with got updated, and forgetting to bump the published value once would reject every bundle forever for everyone who *did* update, while telling them every ten minutes to update an app they already updated. `installed >= required` on the numeric `major.minor.patch` core makes the safe direction safe and degrades a forgotten bump to "gate too permissive" rather than "HCP dead fleet-wide".
  * **New signal `onNativeUpdateRequired`**, carrying `{ version, required, installed }`, on both the events bus and the `WebAppLocalServer` bridge, next to the existing `onDownloadStarted` / `onDownloadProgress`. Nothing in meteor-desktop acts on it — the consuming app subscribes and drives its own native updater; the README documents that as a prerequisite. The refused version is **not** blacklisted, so it is taken as soon as the native catches up, and the signal repeats on every check while the mismatch stands, like the existing blacklist notification.
  * The gate runs **first** in `shouldDownloadBundleForManifest`, ahead of the current/pending/blacklist skips: those answer "do we already have it", this answers "may we run it at all", and the app is entitled to hear that a native update is due even for a version it happens to be holding.
  * Prerelease suffixes are ignored (`5.1.4-beta.1` == `5.1.4`), which is what the beta channel needs. The comparison is numeric per component, not lexicographic — `5.10.0 > 5.9.0`. `semver` is a build-time dependency of meteor-desktop and is not in `lib/skeletonDependencies.js`, so it is ~15 lines in `skeleton/modules/autoupdate/utils.js` rather than a new dependency shipped into every consumer's build.
  * **It is a forward guard, not an eviction, and it only exists in shells that carry it.** An already-installed pre-gate shell downloads and runs a floor-declaring bundle with no resistance, and a bundle a pre-gate shell already fetched keeps loading from `versions/` afterwards — `initializeAssetBundles` restores `lastDownloadedVersion` without consulting the floor. So the gate-carrying native has to ship before floors are published; the README says so where an operator will read it.
  * 17 new tests, none of them mocking anything the harness owns: the gate is exercised on a **real** `HCPClient` built through its real constructor with the real `Module` class and a real `EventEmitter`, using the project's own `Module.__setRendererForTest` seam. Inversion-checked (Rule 41) — disabling the gate call fails three of them.

### Fixed

* **Test-helper signature drift, and a dead method that carried a misleading warning (seeds `meteor-desktop-c1f9`, `meteor-desktop-8577`).**
  * Five `@ts-expect-error` suppressions, all naming `c1f9`, are gone along with the drift they hid. `MeteorServer`'s constructor had lost the `log` parameter its own JSDoc still documented, while `init()` kept calling `this.log.info` in the parent-bundle branch — so that branch would have thrown `TypeError` the first time anything used it, and the only reason nothing noticed is that no test reaches it. `init()` call sites now pass all three arguments, and the local-server helper stopped passing a silently-ignored fourth. **The verification is `tsc` itself:** it errors on an *unnecessary* `@ts-expect-error`, so leaving one behind after fixing the drift fails the gate — the suppressions could not be removed without the fixes being real.
  * A test now exercises the previously-latent branch, and reverting the constructor reproduces exactly the `TypeError: Cannot read properties of undefined (reading 'info')` the seed predicted. The branch was kept and made correct rather than deleted: the helper's parent-aware half — its modRewrite table, source-map header and parent `serveStatic` mount — exists to mimic the incremental HCP serving that this whole epic is about, so deleting the one line would have orphaned all of it.
  * `DesktopPathResolver.readInitialAssetBundleVersion()` is deleted. It had zero call sites anywhere in the workspace, is absent from the README and from `scaffold/`, and duplicated the sha256-of-`program.json` fallback that `assetManifest.js` already implements and the live path actually uses — including a second copy of the "no version in manifest" warning that the version-signal correction above had just fixed in the other copy. Leaving it would have let that correction be undone by whoever revived the method. `crypto` stays imported, still used by the surviving signature statics. **`DesktopPathResolver.readJsonFile()` is deleted in the same release** (seed `meteor-desktop-2498`) — a second dead static on the same class, spotted by the adversarial review of this deletion while reading the post-deletion file. Re-verified immediately before removing it: the only hit anywhere outside the seed store is the definition itself. The two `readJsonFile` hits in `lib/scripts/utils/addScript.js` are a **different**, module-local function of the same name, defined and used entirely within that file. 12 lines; `fs` stays imported, still used by `getInitialBundlePaths`.

* **The `desktop.asar` copy branch is deleted as dead, rather than repaired (seed `meteor-desktop-1886`).** It copied through an unawaited `createReadStream().pipe()` whose errors are emitted a tick after the surrounding `catch` has returned — so they reached no handler at all, escaped the abort added for `meteor-desktop-0cd8`, and, since the pipe was never awaited even on success, let a download finish and promote a bundle while the copy was still in flight. The seed offered two fixes: await the pipe, or find out whether the special case is still needed. It is not.
  * Only `desktopHCP` ever put a `desktop.asar` into an HCP bundle, and that was removed in v6.0.0 (`1bc104c`). The reachability argument is structural rather than historical, though: `cachedAssetForUrlPath` is an exact key lookup by the **requested** asset's urlPath, and requested urlPaths come only from the server's `__browser/manifest.json` or from a `program.json` this module wrote from that body — neither of which Meteor fills with an asar. A stale pre-6.0.0 `versions/` directory is dead weight on disk, never a lookup hit. Measured for corroboration: a real production build's manifest has 281 entries and zero mentioning asar.
  * The one residual state that could still reach the surviving copy — a file literally named `desktop.asar` placed in Meteor's `public/` — now fails **closed**: `copyFileSync` throws synchronously, which aborts the download. The deleted branch failed **open**, promoting a truncated file.

* **A bundle could be promoted while silently missing an asset (seed `meteor-desktop-0cd8`).** In `downloadAssetBundle`'s preparation loop, a failure to create an asset's containing directory called `didFail` and then `return`ed — from the `forEach` callback, so only from that iteration. The asset was therefore never copied *and* never pushed onto `missingAssets`, so nothing downloaded it either; the remaining assets finished normally, `onFinished` fired, and the bundle was moved into `versions/` short one file. The same shape applied to a failed cached-asset copy. The loop is now an `every` whose `false` aborts the whole download, which also removes the Stage 4 contract violation the branch caused — the check used to emit an error and then `onNewVersionReady` for the same download.
  * The test reaches the failure the way production would rather than simulating it: a real file sitting where a parent directory must be makes `lstatSync` throw `ENOTDIR` and then `mkdirSync -r` throw it too, which is exactly the pair the guard catches. Inversion: change `every` back to `forEach` and `finished` arrives after the error.
  * Verified by the reviewer and worth recording, because it is what makes the early return safe: the partially-prepared `Downloading` directory left behind is never promoted — `moveDownloadedAssetBundleIntoPlace` is reachable only from the downloader's success callback, `loadDownloadedAssetBundles` skips both scratch directories, and the next poll quarantines it into `PartialDownload`, so nothing accumulates.
  * Two comments in the same function were corrected: one claimed the in-flight downloader slot is cleared in `didFail`, which the seed `meteor-desktop-912a` work had just stopped being true, and one enumerated the short-circuits above `onDownloadStarted` without the new one (and cited two line numbers that had already drifted).
  * Filed, not fixed: `meteor-desktop-1886` — the `desktop.asar` copy is an unawaited `createReadStream().pipe()` whose errors reach no `catch` at all, so it escapes this fix entirely and can promote a bundle with that file truncated.

* **Dropped two Babel dependencies that were never used, which is what actually blocks a consumer from moving to `@babel/runtime` 8 (seed `meteor-desktop-3170`).** The seed asked whether this package's internal Babel-7 toolchain could move to Babel 8, on the grounds that pinning `@babel/runtime@7.29.7` as a **dependency** keeps every consumer's tree on v7. The premise about the constraint is right; the proposed remedy turned out to be unnecessary, because the constraint comes from a package this repo does not use.
  * **Measured:** `@babel/runtime` and `@babel/register` are imported nowhere in `lib/`, `skeleton/`, `scaffold/` or `tests/`, and `npm ls` shows each as a lone direct edge with no other package requiring it. The only live Babel is `@babel/core`'s `transformFileSync` plus `@babel/preset-env`, in `electronApp.js` `transpileAndMinify`, configured `{ targets: { node: 'current' }, modules: 'commonjs' }` with `babelrc: false` and `configFile: false` — and with no `@babel/plugin-transform-runtime` and no Babel config file anywhere in the repo, that combination emits no `@babel/runtime` references at all.
  * **Confirmed against the built consumer artifact, not just the source:** a real `npm run desktop build` from `frontend/` produces `app.asar` and `desktop.asar` containing **zero** occurrences of `@babel/runtime`, and the generated `.meteor/desktop-build/package.json` lists only `lib/skeletonDependencies.js` plus the consumer's own three — no Babel package is installed into the built app.
  * Removing the two takes 15 packages out of the tree. The lockfile diff is a **pure removal**: no added entries, no version changes. The `semver` and `path-exists` that disappear are Babel's own transitives (`semver@6.3.1`); the root `semver@7.8.5` that `lib/meteorApp.js` and `lib/electronApp.js` import, and the directly-declared `path-exists-cli` the `postinstall` script calls, are both untouched and verified still present in the lockfile.
  * **So the Babel 8 question is no longer blocking anything for consumers**, and what remains — `@babel/core` and `@babel/preset-env` — is build-time only, never shipped, and used through one call whose options are all still valid in Babel 8. `npm audit` unchanged at 5 (the quarantine-deferred pair plus the mocha trio).
  * **This diff was NOT claimed under Rule 64's dependency exemption.** That exemption covers version pins, whose risk lives upstream where a reviewer cannot see it; this is a *removal* resting on a categorical liveness claim, which is exactly what a reviewer can attack. It went through the reviewer and came back with no blocking findings. Its checks: the liveness grep restated at full-repo scope rather than the four directories originally searched (`scripts/`, `plugins/` and root dotfiles included — no `.babelrc`, no `.mocharc`, no `babel` key); `prepublishOnly`'s smoke script and the `postinstall` verified to need neither package; and a **real `npm ci`**, not `--dry-run`, after which `node_modules/@babel/runtime` and `node_modules/@babel/register` are both absent and the suite is 305 passing with lint and checkjs clean.
  * ⚠️ **Removing a `dependency` from a published package is a BREAKING change**, and this one is not yet released. A consumer that never declared `@babel/runtime` itself but relied on receiving it transitively would fail at *its* runtime, not at install. The only known consumer, this workspace's `frontend`, declares its own. The version to publish under is an operator decision and the package is still at 6.1.0, unpublished.
  * The reviewer spotted a third package of the same kind, which the grep pattern used here could never have matched: **`babel-plugin-istanbul` is gone too** (seed `meteor-desktop-9e04`). It only does anything when loaded through a Babel register hook or a Babel config, and after the two removals above there is neither; `nyc` mentions it in its README and nowhere in its code, and the `nyc` block is a passthrough (`instrument: false`, `sourceMap: false`, excluding `lib`, `plugins`, `scaffold` and `tests`). Verified the way that seed prescribed rather than by inspection: removed, real `npm ci`, and the coverage table `npm test` prints is **byte-identical** to before — `All files | 0 | 0 | 0 | 0` — with 305 still passing. A devDependency, so unlike the two above it carries no consumer-facing breaking change.

* **The CLI could not tell a script that anything had gone wrong (seed `meteor-desktop-a8f8`).** Three separate paths all reported failure as success, which matters exactly for the scripted smoke-launch case `just-run` exists for.
  * **Electron's exit code is now forwarded.** `lib/electron.js` `run()` attached only stdout/stderr listeners, so `meteor-desktop run` / `just-run` exited 0 whether the desktop app quit cleanly or crashed. A signal termination is reported as a failure rather than a silent 0, since a launch that had to be killed is not a successful one. `process.exitCode` rather than `process.exit()`, for the same reason the existing spawn-error handler gives: `process.exit` truncates a piped stdout, and the app's own output is what a smoke launch is reading.
  * **Every action handler now reports its rejection.** `run`, `build`, `init`, `runPackager` and `buildInstaller` all fired an async call unawaited with no catch, so a rejection surfaced as an unhandled rejection — a bare stack with no context line on Node 24. `justRun` was given a catch by the `meteor-desktop-86d2` fix; the other five now share one `reportAndExit` rather than five copies of it. All six were confirmed `async` before adding `.catch`, since a `.catch` on a non-promise would have broken the command outright.
  * **`not in a meteor app dir` exited 0.** A bare `process.exit()` takes `process.exitCode`, which is 0 there — so the CLI printed an error and then told the shell it had succeeded. Found while fixing the two gaps above, on what is probably the CLI's most common error path, and fixed with them because it is the same defect class. Covered by a functional test that drives the real `.bin` symlink entry rather than the file's realpath.
  * **`build-installer` and `package` were still swallowing their own core failure**, so the new `.catch` could never fire for them — found by the adversarial review of the first version of this fix, which is the point: the CHANGELOG sentence above was literally true and the seed's defect was still live for two of six commands. `buildInstaller(throwError = false)` logs an electron-builder failure and resolves unless asked to rethrow, and the CLI was not asking; it now passes `true`. `runPackager` ended with a floating `packageApp().catch(log)`, so it resolved while packaging was still running and the process exited 0 after logging a failed package; it now awaits and rethrows, which also makes the command actually wait for the packaging it was asked to do.
  * **The `exit` handler is total.** Node's docs say `'exit'` *"may or may not fire after an `'error'` has occurred"*, and in that case both arguments are `null` — which would have assigned `process.exitCode = null`, i.e. unset, silently undoing the `meteor-desktop-86d2` spawn-error exit code set moments earlier. Measured not to fire on Node 24 here, so this is a guard against a documented possibility rather than an observed failure, and it is written down as such.
  * **`build` and `run` exited 0 after `seems that you do not have a .desktop dir`, and now exit 1 (seed `meteor-desktop-a86c`).** This was the one deliberate exception, carrying its own justification — *"Do not fail, so that npm will not print his error stuff to console."* **That rationale is stale, and it was measured rather than argued away:** on npm 12.0.2 a script exiting 1 prints two `npm notice` lines and no error block at all, so the cost the comment was avoiding no longer exists. It was also the sole `process.exit(0)` left in `lib/` — every other exit there is already 1. Options (b) TTY-detection and (c) document-it-in-the-README were both dropped once the measurement removed the tradeoff they existed to split. Verified through the real `.bin` symlink: `build` 0→1, `run` 0→1, with the inversion checked in both directions.
  * **Not changed, and deliberately so:** `lib/scripts/addToScripts.js:16` also calls `process.exit(0)`, which the seed guessed was "probably the same decision". It is not. That file is the package's `postinstall`, and a non-zero exit from a postinstall aborts the consumer's entire `npm install`. Failing to add a convenience `desktop` entry to their `package.json` must not break their install, so that 0 is correct and stays.
  * 4 new tests. The exit-code ones drive a **real** child process that genuinely exits 3, exits 0, and kills itself with SIGTERM — no stubbed emitters, and they wait on the handler actually running rather than on a fixed timer. All inversion-checked: deleting the `exit` handler fails 3, treating a signal as a clean exit fails 1, restoring the bare `process.exit()` fails 1. **Explicitly not covered by a test:** the `build-installer` rethrow and the `package` await, because reaching either requires a real electron-builder or electron-packager run that this repo does not install; both are verified by reading `lib/index.js` and by `tsc` on the changed call, and that is weaker evidence than the rest of this entry. What *is* covered is the contract they serve: a functional test drives the real `.bin` symlink and asserts a rejecting action exits non-zero.
  * **Exercised on a real Electron process, through the consumer's own `node_modules/.bin/meteor-desktop`** (ENGINEERING Rule 48), not only in unit tests: `just-run` from `frontend/` launched the packaged app, and killing it with `SIGTERM` — which the app handles, running its `before-quit` cleanup — exits **0** with no log, while `SIGKILL` exits **1** with `electron was terminated by signal SIGKILL`. Before this change both exited 0. `npm run desktop build` from `frontend/` also passed every A7 gate with the change installed. Not exercised: dev-mode `npm run desktop` against a live Meteor server, and Windows.

* **Two HCP checks could download the same bundle twice into one directory, and a resumed download re-fetched everything (seeds `meteor-desktop-912a`, `meteor-desktop-932b`).** Both were dead code that looked live, and both sat in `assetBundleManager.js`.
  * **`this.assetBundleDownloader` was declared, nulled in four places, and never once assigned** — `downloadAssetBundle` created a `let` local instead. So both guards in `checkForUpdates` were dead: a second check for the *same* version started a second download rather than returning, and a check for a *different* version never cancelled the running one. Both then wrote into the same `Downloading` directory while `moveExistingDownloadDirectoryIfNeeded` renamed it out from under whichever was still running, so the in-flight writes threw `ENOENT`. Reachable on any slow link — the renderer polls every 10 minutes and the production bundle takes ~3 minutes at 50 KB/s and ~45 minutes at 3.3 KB/s. The field is now assigned; both guards work.
  * **New signal `onDownloadAlreadyInProgress(version)`**, because reviving the "already downloading" early return revived a branch that returned *silently* — and Stage 4 (`meteor-desktop-5aa1`) had just established that every check ends in exactly one observable outcome. Harmless while dead, it would have been the one path violating that contract the moment it came alive, so it gets its outcome in the same change. Routine rather than exceptional: on a slow link a poll frequently lands mid-download.
  * **A superseded download no longer reports a stall.** Reviving `cancel()` created a new problem: `cancel()` cannot reach the cancelled download's stall watchdog, which is a closure variable by design, so minutes later it would fire and hand the renderer a "download stalled" error for a version deliberately abandoned. The watchdog now returns early when the download it was armed for was cancelled. The timer stays per-download rather than becoming a manager field — the two are not the same mechanism and neither replaces the other (Rule 31): the field answers "is a download in flight" and is cleared by *any* `didFail`, including a concurrent poll's manifest fetch failing, which would disarm a watchdog parked there.
  * **Cache reuse was dead, and the naive fix would have been a correctness hazard.** The partial-download branch guarded on `fs.accessSync(file)`, which returns `undefined` on success and throws on a missing file — so it could never be truthy and every retry re-downloaded the whole bundle. But simply switching to `existsSync` would have resurrected the arch mismatch that seed `frontend-7c13` fixed, because a reused asset is copied straight into the new bundle and never passes `verifyResponse` — whatever is on disk is what the app runs.
  * **So the two cache sources are now held to different tests, because the same comparison does not mean the same thing in both.** A complete bundle in `versions/` carries its *own* version's manifest, so agreeing on `hash` is a genuine claim by two independently written manifests, and those bytes already passed `verifyResponse`; hash or sri will do. The `PartialDownload` directory keeps the manifest of the **previous attempt** — `moveExistingDownloadDirectoryIfNeeded` renames the half-finished directory wholesale, `program.json` and all, and it runs *before* the new manifest is written into the fresh one. On a same-version retry that leaves the identical manifest, so comparing hashes there compares that manifest with *itself* and cannot fail whatever bytes are lying in the directory; on a supersede it leaves an older version's manifest, where the comparison would be genuine. The caller cannot tell the two apart, and the indistinguishable case is the dangerous one, so only `sri` — which `verifyResponse` actually checked against the bytes — is accepted there. In both sources `cachedAssetForUrlPath`'s other branch, `asset.cacheable && hash === null`, is refused outright: it matches on url path alone and asserts nothing about the bytes.
  * **The in-flight slot is released only by its owner.** Found by the adversarial review of this change, and it would have re-opened the very race being fixed: `didFail` cleared `this.assetBundleDownloader` unconditionally, and `didFail` is reached by callers with no download of their own — the manifest fetch's own `.catch` among them. So one poll's network blip released another poll's running download and put both revived guards straight back to sleep. Clearing moved out of `didFail` and `didFinishDownloadingAssetBundle` into the three points where a download's own run actually ends.
  * **Known cost, filed as `meteor-desktop-6f12`:** `AssetBundle` constructs every source-map asset with `hash: null, sri: null, cacheable: true` regardless of the manifest, so source maps can offer no identity and are now re-fetched on every update. They were previously reused through the url-path-only match, which is precisely the hazard this change closes — so the refusal is correct, but it is a permanent class rather than an edge case. Whether it costs anything depends on whether a release desktop bundle ships source maps at all, which the seed says to measure before fixing. Also filed: `meteor-desktop-0cd8`, a pre-existing `mkdir`-failure path in `downloadAssetBundle` whose `return` exits only the `forEach` iteration, dropping an asset from both the copy and the download list so a bundle can complete while missing it.
  * **`sri` is decisive in both directions.** Present on both sides and equal, it proves the bytes — it is a base64 sha512 of the content and the one field `verifyResponse` checked before those bytes were written (the legacy `hash` is *not* a content digest, as `verifyResponse` says in as many words). Present on both sides and different, it *disproves* them however well the hashes match: that combination is two manifests contradicting each other about one asset version, and the content digest is the one that describes content. Re-hashing the file instead would be both slower and wrong — a `js` asset is rewritten on disk by the isDesktop injector after verification, so it matches no digest in any manifest.
  * 10 new tests against a real `http` server and real bundle directories on disk, no stubs. Every branch of the rule is inversion-checked (Rule 41): restoring `accessSync` fails 3, letting the partial directory reuse on hash fails 1, accepting the url-path-only match fails 1, and making `sri` non-decisive fails 2; removing the field assignment fails all 4 overlap tests. The existing functional test `should only download changed files` is what caught an earlier, blunter version of this rule requiring `sri` everywhere — its fixtures predate `sri` entirely, and it went from 5 downloads to 6.

* **The HCP version signal was never broken, and the code no longer says it was (epic `meteor-desktop-e490`, requirement 2).** The epic recorded, as its DECISIVE root cause, that production serves `autoupdateVersion: null` because the rspack bundler fails to populate `WebApp.clientPrograms`, leaving HCP with no version to compare against. Both halves are wrong, and the second had already pointed one session at a bundler fix that is not needed.
  * `Autoupdate.autoupdateVersion` is an **override input**, not a computed output. `autoupdate_server.js` sets it to `null` beside the comment *"Tests allow people to override Autoupdate.autoupdateVersion before startup"* and then reads it as the default for `AUTOUPDATE_VERSION`; `webapp_server.js` reads it the same way in the manifest route. Null is its correct resting value, and observing it says nothing about HCP.
  * `WebApp.clientPrograms` **is** populated under rspack. Measured against production 2026-08-28: `/__browser/manifest.json` carries `version c1c0918605b1be747866f593754f82ac66313e47`, and `autoupdate.versions['web.browser']` carries four *distinct* hashes — distinct also proving `AUTOUPDATE_VERSION` is unset, since it would collapse them to one value. Six consecutive fetches returned the identical version; an earlier fetch the same day returned a different one, so it tracks deploys rather than drifting.
  * A build artifact on disk **never** carries `version`, by design: `webapp` attaches lazy version getters to `WebApp.clientPrograms[arch]` and materialises them only when serving `/__<arch>/manifest.json`. Measured: the on-disk desktop build's `program.json` and the copy baked into a freshly built `meteor.asar` both have exactly the keys `["format", "manifest"]` (the web build adds `hmrVersion`), while the served production manifest has `["format", "manifest", "version", "versionRefreshable", "versionNonRefreshable", "versionReplaceable", "PUBLIC_SETTINGS", "meteorRuntimeConfig", "refreshableAssets"]` — the four version fields exist only on the served copy. So the skeleton's sha256 fallback is the *normal* path for an embedded bundle — and it announced itself with `log.warn('asset manifest has no version field')` on **every app startup**, which is a large part of how the epic came to record a defect that does not exist.
  * `AssetManifest` now takes an `origin`. A `bundled` manifest logs the fallback at debug with the explanation above; a `served` manifest still warns, because there a missing version really is abnormal. `served` is the default, so a future call site that forgets to declare its origin keeps the warning rather than silently losing it. Four tests, two inversion-checked: make both branches warn and the bundled test fails; flip the default and the default test fails.
  * **What is genuinely true, and stays true:** production really does serve `autoupdateVersion: null`, and `verifyRuntimeConfig`'s fallback to `autoupdate.versions['web.browser'].version` (epic item G2, `assetBundleDownloader.js`) is exactly what makes that harmless. **That fallback must not be removed on the strength of this correction.**
  * **Deliberately not changed.** An embedded bundle's derived version can never equal the server's, so a fresh install's first check always downloads. That is correct rather than wasteful: measured against the live production manifest, a freshly built desktop bundle shares only 130 of its 280 client entries with production by `(path, hash)`, and the 150 it lacks are 5,807,224 bytes — that delta, not the whole bundle, is what a first sync actually fetches, because `AssetBundle` filters own assets against the parent bundle. (The 278-entry figure in the Stage 4 note above was measured earlier the same day, before a deploy; the manifest is 280 entries now) — the two bundles genuinely differ. They differ for reasons no build-time stamp can remove: the desktop build's rspack context emits `build-chunks-local-desktop/` where production emits `build-chunks/`, it carries a `__rspack__/client-rspack.js` production does not list, and `WebAppHashing.calculateClientHash` hashes `JSON.stringify({ PUBLIC_SETTINGS })` first — while a release build's `settings-electron.json` public block differs from production's (`devLoginAssist` present, `persistent_session` absent). Stamping the built manifest with a locally computed hash would swap one never-matching value for another and force a one-time `versions/` wipe on every user for nothing.
  * Also filed, not fixed: `meteor-desktop-8577` — `DesktopPathResolver.readInitialAssetBundleVersion()` has zero call sites and carries a second copy of the same misleading warning.

* **HCP checks can no longer wedge silently, and every phase is observable (seed `meteor-desktop-5aa1`, Stage 4 of `meteor-desktop-e490`).** e490 recorded the symptom from production: "an ~8-minute SILENT window emitting zero progress events ... users staring at a dead 0% bar restart the app". Two of the three causes were structural.
  * **Neither fetch had a timeout.** `globalThis.fetch` has no default, so a server that accepted the connection and never answered left the check hanging forever, emitting nothing of any kind. The manifest fetch now carries `AbortSignal.timeout(hcpRequestTimeout)`, default 30 s — a total timeout is the right shape for one small JSON document. It surfaces through the existing `.catch` as an ordinary error, which the renderer hears.
  * **A stalled bundle download had no watchdog.** Deliberately NOT a per-asset total timeout: progress is only observable once an asset is verified and written, so a total timeout would kill a download making steady progress on a slow link — a regression, not a fix. Instead an inactivity budget, `hcpStallTimeout`, re-armed by every completed asset, so it measures "nothing finished, with six assets in flight". The default of 5 minutes is derived rather than guessed: measured against the live production manifest — 278 client entries, 8.7 MB, largest single asset 998,561 bytes — that asset takes 20 s at a punishing 50 KB/s, so to false-fire it would have to sustain under 3.3 KB/s, at which rate the whole bundle needs 45 minutes.
  * **A cancelled download could still report success.** `cancel()` ends the queue but cannot abort requests already in flight, and the downloader's `onResponse` had no cancel guard — so a late response could write its asset, empty `missingAssets`, and call `onFinished` after the download had already failed. The consumer would receive an error and then `onNewVersionReady` for the same download, and reload onto it. `onResponse` now returns early on `cancelInvoked`, the same self-guard `didFail` has always had. One mechanism, at the source: the watchdog does not also detach callbacks.
  * **Two new phase events**, `onUpdateCheckStarted(rootUrl)` and `onUpdateNotAvailable(version)`, on the events bus and the `WebAppLocalServer` bridge. Every check now ends in exactly one outcome — started, then one of error / not-available / native-update-required / download-started -> progress -> new-version-ready — so a wedged check can no longer look identical to a healthy idle app. `onUpdateNotAvailable` fires only for the current/pending skips; a blacklisted version keeps reporting through `onError` alone, so one skip never carries two contradictory meanings.
  * **The watchdog's timer is per-download, not per-manager.** It started as a field and the adversarial review showed that was wrong: `this.assetBundleDownloader` is never assigned (seed `meteor-desktop-912a`), so `checkForUpdates`'s "already downloading" guard is dead and a 10-minute poll landing mid-download starts a second one — which on a slow enough link is exactly when it happens. A single manager-wide slot would then let each download disarm the other's watchdog, and any unrelated `didFail` (a concurrent poll's manifest fetch failing, say) would disarm it too — reintroducing the silent wedge precisely in the conditions it exists to catch. The handle is now a closure variable cleared by that download's own success and failure callbacks.
  * Neither timeout blacklists anything — the only writer of `blacklistedVersions` is the startup-timer revert — so the next 10-minute poll simply retries, reusing whatever was already fetched.
  * 11 new tests, and **not one mock**: a real `http` server on an ephemeral port, driven into the actual failure shapes — accept-and-never-answer; **answer with headers and then no body**, which is the hang shape a connect-hang test does not reach and which settles empirically that the abort covers the response body read, not just the headers; respond after the watchdog has fired; 18 assets in three concurrency waves that outlast the window. Seven inversion checks (Rule 41), each run and each verified to fail the intended test: removing the `signal`, the initial arm, the re-arm on progress, the clear on success, the `cancelInvoked` guard, `notifyUpdateCheckStarted`, and `notifyUpdateNotAvailable`. The re-arm inversion did not fail on the first attempt — six assets at 60 ms all landed in one concurrency wave, inside the window — so the test was rewritten until it did, and then widened again (30 assets, five waves, 220 ms of slack per wave) after one full-suite run flaked on a loaded machine. 283 passing.

* **`just-run` launches again (seed `meteor-desktop-86d2`).** `MeteorDesktop.justRun()` called `this.electron.run()` without ever initialising the `Electron` instance, so `this.electron` (the resolved dependency, set by `Electron.init()`) was `undefined` and every invocation died with `TypeError: Cannot read properties of undefined (reading 'dependency')` at `lib/electron.js:37`. The `run` and `build` paths were unaffected because `electronApp.build()` awaits `electronApp.init()`, which is the only caller of `electron.init()`. `justRun()` is now `async` and awaits `this.electron.init()` first; scaffolding is deliberately not run, since `just-run` is documented as an alias for `electron .` in an existing `.meteor/desktop-build`.
* **`just-run` failures now exit cleanly with code 1** instead of crashing as an unhandled rejection: `lib/bin/cli.js`'s handler fired the (now-async) call unawaited, so nothing reported the error. It now `.catch()`es, prints and exits 1.
* **`Electron.run()` handles the child's `error` event.** With `just-run` reachable for the first time, `just-run` in an app that was never built spawns into a nonexistent `.meteor/desktop-build` and emits `ENOENT` asynchronously — an unhandled `'error'` event, i.e. a bare stack. It now names the missing build dir and the real `spawn` error, and sets `process.exitCode = 1` rather than calling `process.exit()`, which would truncate the message on a piped stdout — the scripted smoke-launch case `just-run` exists for.
* Covered by two new tests, both inversion-checked and both mock-free: `tests/unit/index.test.js` asserts `run()` observes a completed `init()` (removing the `await` fails it), and `tests/unit/electron.test.js` spawns into a genuinely nonexistent build dir so the real `ENOENT` reaches the real handler (removing it fails with the uncaught error it used to produce).

### Security

* **`npm audit` 10 -> 5, no downgrades (seed `meteor-desktop-7683`).** One scoped `npm audit fix` — never `--force`, which "fixes" `serialize-javascript`, `mocha` and `diff` by installing **mocha 11.3.0, a downgrade** from the current 11.8.0. Cleared: `brace-expansion` (high, all 11 nested copies), `qs` (moderate) with its `side-channel` bump, `linkify-it` (high), and `uuid` (moderate), the last of which disappears from the tree entirely because `istanbul-lib-processinfo` 3.0.1 dropped it. `mocha` stays at 11.8.0.
* **Two advisory fixes deliberately held back by the 7-day supply-chain quarantine.** `npm audit fix` wanted `js-yaml` 4.3.2 / 3.15.2 (published 2026-08-26) and `markdown-it` 14.3.1 (2026-08-27) — 1-2 days old at the time of the pass, and each a coordinated multi-branch security release, so there is no older fixed version to take instead. Those five lockfile entries were reverted to their previous in-range versions after the fix ran; a real `npm ci` validates them, and `grep` confirms none of the three versions survives anywhere in the tree, at any nesting depth. Retry on or after 2026-09-02 (`js-yaml`) and 2026-09-03 (`markdown-it`). Every version that *did* land was date-checked individually: the newest is `brace-expansion` at 2026-07-30, four weeks clear of the window.

### Removed

* **Three vestigial arguments, and the three `@ts-expect-error` suppressions that were hiding them (seeds `meteor-desktop-ab39`, `meteor-desktop-566b`).** Both seeds asked whether a dropped parameter had taken a feature with it. Answered from history, and the answer is no in both cases.
  * `skeleton/preload.js` — `fetchFile` and `fetchAsset` passed a second argument, `false`, to `getFileUrl` / `getAssetUrl`, which have always taken exactly one. Not signature drift: `git show 5f084e6` (2016-12-03) is the commit that introduced all four methods, and the stray `false` is there in that very first version, against one-parameter signatures. It never meant anything.
  * `skeleton/modules/autoupdate/assetBundleManager.js` — the initial-version branch passed `didFinishDownloadingAssetBundle(bundle, true)`, the `true` being an `isInitialAssetBundle` flag the method dropped in `1bc104c` (`feat!: remove desktopHCP`, v6.0.0). **No special-casing was lost.** That flag's only consumer was `handleDesktopBundle`, which decided whether to write a desktop version into `meteor.asar` and which `desktop.asar` to copy into the desktop bundle path — the entire desktopHCP feature, deliberately removed in the same commit. `handleDesktopBundle`, `writeDesktopVersion` and `desktopBundlePath` are all gone from the tree; the caller's `true` was the last trace of it. The JSDoc the seed flagged had already been corrected in `41f390f`.
  * Deleting the arguments is what makes the suppressions safe to remove, and `tsc` is now the standing check: reintroducing either argument fails `npm run checkjs` with `TS2554: Expected 1 arguments, but got 2` — verified by doing exactly that at both sites, `skeleton/preload.js(80,52)` and `skeleton/modules/autoupdate/assetBundleManager.js(134,83)`. Neither callee reads `arguments`, so the deletion is provably inert at runtime — 255 passing, unchanged.

* **`proxyquire` devDependency** — zero imports anywhere in `lib`, `tests`, `scaffold`, `skeleton` or `scripts`, and established during the `mockery` removal not to be a viable replacement either: the modules under test are ESM reaching their dependencies through a *lazy* `createRequire()`, while proxyquire's stubs apply only during the load call and only to direct dependencies. Takes 5 packages out of the tree.
* **Two inert `registerMock` calls** in `tests/unit/skeleton/app.test.js`. `registerMock('fs-plus', …)` and `registerMock('./desktopPathResolver', …)` could never fire: `skeleton/app.js` reaches both through ESM `import` (lines 4 and 7), which no `Module._load` hook can observe. They were equally dead under `mockery`, which used the same hook. The suite is unchanged at 255 passing — which is the point.

## v6.1.0 <sup>28.08.2026</sup>

> **Never published.** The version was bumped in `package.json` but no tag was ever pushed, so this never reached the registry. Everything below ships in `v7.0.0`.

**Dropped `winston` from the skeleton — the logger is now ~200 lines with zero dependencies (seed `meteor-desktop-f570`).** `skeleton/loggerManager.js` was a thin wrapper over `winston@3.13.0` — **1.4 MB and 11 transitive dependencies installed into every consumer's `.meteor/desktop-build`** — to obtain one console sink, one 5 MB x 5 rotating file sink, and a name -> logger registry. Worse, the wrapper had been written against **winston 2** and never migrated, so it was paying that cost for behaviour it was not getting. Every claim below is measured against a real 4.1 MB production `run.log`, not inferred:

| What the code asked for | What actually happened |
|---|---|
| `logger.filters.push(...)` to prefix every line with `[entityName]` | winston 3 removed `filters` outright. `grep -c '^\['` over the whole file returns **0** — the prefix never appeared, in any line, ever |
| `json: false` and `colorize` on the File transport | winston 2 transport options; winston 3 takes a `format`. Output was JSON regardless |
| `l.info('app data dir is:', userDataDir)` | The second argument was **dropped** — winston 3 needs `format.splat()`. Line 1 of run.log reads `{"level":"info","message":"app data dir is:"}` with the path gone. **5 call sites** logged this way |
| `l.error(e)` on a caught Error | No stack recorded. The entire 4.1 MB file contains no `stack` key |

Replaced rather than swapped for `electron-log`: the used surface is five level methods, one console sink, one size-rotated file and a registry. Trading one dependency for another buys nothing here.

### Changes

* **`skeleton/loggerManager.js` — rewritten, 318 lines, no imports beyond `fs`/`path`.** Exports the same `default class LoggerManager` with the same public surface — `getMainLogger()`, `configureLogger(name)`, `configureSubLogger(name, sub)`, and `logger.getLoggerFor(sub)` on each logger instance — so no caller changed. `RotatingFile` holds one descriptor open, writes with `fs.writeSync`, and rotates `run5 <- run4 <- ... <- run1 <- run.log` with the oldest unlinked — the same `MAX_FILE_SIZE = 5242880` / `MAX_ARCHIVES = 5` set winston's File transport produced.
* **The record shape is `{ level, message, entity }`, in that order, with the message text unprefixed.** This is a hard constraint, not a preference: `frontend/.desktop/telemetry.js:42` strips HCP asset churn out of uploaded crash reports with `RUN_LOG_NOISE = /"message":"(saving \/|making bundle object|...)/`, which anchors on `"message":"` immediately followed by the text. "Fixing" the dead `[entity]` prefix by prefixing the *message* would have silently killed that filter and flooded every uploaded report with asset noise. The entity gets its own trailing field instead.
* **The four silent losses above are fixed**: multiple arguments are joined, `Error` arguments keep their stack (newlines escaped by `JSON.stringify`, so a record is still exactly one physical line), and the entity is recorded in a field that actually reaches the file.
* **`lib/skeletonDependencies.js` — `winston: '3.13.0'` removed.** Consumers' `desktop-build/package.json` no longer installs it.
* **The silent `Function.prototype` fallback is gone.** The old `try { require('winston') } catch` replaced every level method with a no-op, so a failed require lost `run.log` for the whole session with no error — and it never defined `verbose`, which the skeleton calls **20 times**, so it would have thrown rather than no-opped. A write failure now reports once and backs off (`RETRY_AFTER_WRITES = 100`) instead of disabling the sink permanently.
* **Half of `frontend-d466` goes with it.** That seed records a launch-time `MaxListenersExceededWarning: 11 listeners` attributed to winston's File transport accumulating one listener per module logger. The new sink is a single open descriptor written with `fs.writeSync` — no `EventEmitter`, no stream, no `.on(` anywhere in the file — so that warning has no producer left. Stated structurally, not as an observation: confirming it is part of the same Rule 48 launch below. The seed's other half (upstream `DEP0180 fs.Stats` from Electron's asar fs wrapper) is untouched.
* **Orphans removed in the same sweep**: the dead `mockery.registerMock('winston', ...)` in `tests/unit/skeleton/app.test.js`, `'winston'` in `eslint.config.js`'s `import-x/core-modules`, and six now-false `@param {Object} log - Winston logger instance` JSDoc lines (two of them in `scaffold/`, i.e. shipped into every new consumer's `.desktop/`).

### Verification (Rules 41/48/57)

* **28 checks across three runs of the real module** — record shape and level routing (14), rotation and write-failure backoff (9), recovery from a real `EBADF` (5). Rotation asserts the archive set stays bounded at 5 + live and that the oldest is unlinked.
* **No mocks.** Per this workspace's Anti-Mock Rule, the failure paths are provoked with real operating-system errors: a genuinely nonexistent directory for `ENOENT` on open, and `fs.closeSync` on the sink's own descriptor for `EBADF` on write, so the production `catch` branch runs for real. No `sinon`, no `mockery`, no `registerMock` anywhere in `tests/unit/skeleton/loggerManager.test.js`.
* **Consumer coupling checked, not assumed.** `frontend/.desktop/desktop.js:31-35` sets `log.transports.console.level` / `log.transports.file.level` — that `log` is `electron-log` (imported at module scope, line 5), **not** this logger, so the winston-shaped `transports` API is not a consumer dependency. The only real coupling is `telemetry.js`'s `RUN_LOG_NOISE`, preserved above and re-verified by executing the regex against the new records.
* `eslint` clean, `checkjs` clean.
* **Rule 48 consumer exercise: RUN, on this exact version, against the real consumer.** `npm pack` produced the **6.1.0** tarball; it was installed into `frontend/node_modules` (with `package.json` and the lockfile left untouched and verified byte-identical afterwards) and `npm run desktop build` was run from `frontend/`. Exit 0, and the **A7 build summary passed every gate** (A4 desktop.asar content, A2 bundle structure, A2.5 hash coherence, injectIsDesktop, A2.6 runtime-config URLs, A3 meteor asar, A3.5 manifest-asset coherence). Measured on the produced artifacts:
    * `.meteor/desktop-build/package.json` dependencies: **winston absent**, and no `winston` directory under `.meteor/desktop-build/node_modules` — the 1.4 MB and its 11 transitive dependencies no longer reach a consumer build at all.
    * `loggerManager.js` extracted back out of the packaged `app.asar`: **2,866 bytes minified**, containing `RotatingFile`, `MAX_FILE_SIZE=5242880`, `MAX_ARCHIVES=5`, `RETRY_AFTER_WRITES=100` and `JSON.stringify({level,message,entity})`, with **zero** winston requires. The change reached the shipped artifact through the real build path, not just the source tree.
* **And it was launched.** Electron was started on that build exactly as `just-run` does (`cwd` = `desktop-build`, argument `.`, `ELECTRON_ENV=development`). It logged `skeleton version 6.1.0` — so this is the artifact being published, not a stand-in — and wrote **58 new records** into the real `userData/run.log`. All first-contact evidence, not inference:
    * **Zero** of the 58 records failed the `{ level, message, entity }` JSON shape.
    * Levels present: `debug` 20, `info` 19, `verbose` 10, `warn` 8, `error` 1. `verbose` is the level the old fallback never even defined; the single `error` is the expected manifest fetch failure, since no Meteor dev server was running.
    * **10 distinct entity names**, including sub-loggers from `getLoggerFor` (`autoupdate/AssetBundle/AssetManifest`, `meteor-desktop-splash-screen/splashWindow`). Before this change that field reached the file zero times, ever.
    * The very first record reads `app data dir is: /Users/andreaswest/Library/Application Support/yourDNA.family` — **with the path**. That is the exact line whose second argument winston was dropping.
    * **The consumer contract holds:** `frontend/.desktop/telemetry.js`'s `RUN_LOG_NOISE` was executed against those 58 real records and matched 5, the same HCP noise classes it was written for (`making bundle object`, `loading manifest from`, `280 entries. (Version: ...)`, `checking for updates`, `trying to query`).
    * **`MaxListenersExceededWarning` count in the launch's stderr: 0** — the `frontend-d466` half predicted above, confirmed. `DEP0180 fs.Stats` is still there, which is right: that half is upstream Electron and this change never claimed it.
    * Incidentally, `frontend`'s own `splashGuard` fired 5 times and closed the plugin's orphaned splash window on every sweep event, through the new logger, at `warn`.
* **The consumer coupling is two things, not one.** The record-shape coupling (`RUN_LOG_NOISE`) is the fragile one and is covered above. There is also a **method-surface** coupling: `telemetry.js` calls `.warn`/`.info` on the injected logger, so the level set is a contract too — `error`/`warn`/`info`/`verbose`/`debug` are all still defined, and `silly` deliberately is not (nothing in `frontend/.desktop` calls it; checked).
* **Still not exercised:** `npm run desktop` in dev mode, which needs the Meteor dev server up, and a Windows launch. The production build path and a real Electron launch are covered above.
## v6.0.30 <sup>18.08.2026</sup>

**Capped HCP asset-download concurrency at 6 (seed `meteor-desktop-3669`).** `assetBundleDownloader.js` built its work queue as `new Queue()`, and the `queue` package defaults to `concurrency: Infinity` (`queue/index.js:18`) — so `resume()` fired **every** missing asset at once. For the yourdna.family bundle that is a **285-request simultaneous burst** at the Meteor server on every hot code push. A single shed response reaches `didFail`, which cancels the whole download, and the app then silently stays on its baked bundle, because the reload is gated on `onNewVersionReady` and a failed download never fires it. Users stop receiving updates without any error they can see.

### Changes

* **`skeleton/modules/autoupdate/assetBundleDownloader.js`** — added `DOWNLOAD_CONCURRENCY = 6` and passed it to `new Queue({ concurrency })`. One-line behaviour change; completion detection is unaffected because it keys on `missingAssets.length === 0` after each splice, not on queue drain, and every asset is still pushed before `queue.start()` runs.
* **6, not "just under the measured ceiling":** the probe below had the production server to itself. Real clients share it with live users and with each other, so the cap is set an order of magnitude below where shedding began rather than at its edge.
* **No retry was added.** The unbounded burst is the cause; a retry would be a second mechanism layered over an unfixed one and would mask exactly the signal this change removes (`ENGINEERING.md` Rules 11/31). The shell already re-checks unconditionally every 10 minutes (`skeleton/desktop-hcp.js:107` `CHECK_INTERVAL_MS = 10 * 60 * 1000`, armed by the `setInterval(requestCheck, …)` at `:164` — a plain timer, not something a failed download disarms), so a genuinely transient failure still resolves itself without a restart.

### Verification (Rules 41/57)

* **Measured against production 2026-08-18**, replaying this downloader's exact request shape (modern UA, `Connection: close`, `?meteor_dont_serve_index=true`): manifest 200 with 285 entries; the reported failing asset 5x sequential → 5x 200; 20 concurrent → 20x 200; 80 concurrent → 80x 200; 151 concurrent burst 1 → 151x 200; burst 2 → 151x 200; **burst 3 → 103x 200, 48x 503**; 5x sequential immediately after → 5x 200. The assets and the manifest are healthy; the failure is purely load shape, and it needs a *repeated* burst, which is why it presents as intermittent.
* **New unit test** `tests/unit/skeleton/assetBundleDownloader.test.js` → "never has more than the configured number of asset requests in flight": 40 missing assets, an `httpClient` stub that never settles (a rejection would reach `didFail` and end the queue, making the ceiling unobservable), asserts `maxInFlight === 6`. **Inversion run:** restoring `new Queue()` fails it with `expected 40 to equal 6`.
* Full unit suite 121 passing, `eslint` clean, `checkjs` clean.
* **Consumer note, and it is a trap:** `frontend` locks this package at 6.0.29 (`package-lock.json`, resolved from the registry), so a plain `meteor npm install` after publishing does **not** pick up a new version — npm honours a lock that already satisfies `^6.0.29`, the desktop build bakes the old skeleton, and nothing errors. The frontend step is `meteor npm install @a4xrbj1/meteor-desktop@<new version>`, then confirm with `meteor npm ls @a4xrbj1/meteor-desktop` before building.
* **NOT verified here:** no real HCP download was exercised end-to-end. That needs this version published, installed in `frontend`, a desktop build, and a server deploy carrying a newer bundle — see `ENGINEERING.md` Rule 48. The end-to-end gate is: re-run the 151- and 285-way bursts with zero 503s across three consecutive bursts, then watch a real app apply an update in-session (`onNewVersionReady` fires and the overlay completes instead of being dismissed with "download failed").

**Deleted the orphaned `ElectronApp.ensureDeps()` — dead code since 2018-03-12, and unconditionally broken since 2018-10-03 (seed `meteor-desktop-3129`).** The `this.runNpm` calls the type-check flagged in v6.0.26 were never a defect in a live path; they were the *symptom* of an orphaning. `cd3e815` ("Implement install-local", 2018-03-12) **replaced** `build()`'s `await this.ensureDeps()` with `handleStateOfNodeModules()` + `rebuildDeps(true)` and left the method body behind — a mechanism swapped in without retiring the one it replaced (`ENGINEERING.md` Rule 31). Seven months later `41e1907` ("Decouple main dependencies") deleted `ElectronApp.runNpm` — whose own JSDoc already read `NOT IN USE RIGHT NOW // DEPRECATED` — and rerouted its one live caller, `linkNpmPackages`, to `this.$.meteorApp.runNpm`. `ensureDeps`, dead for seven months by then, was overlooked, so its two calls became dangling references. Zero runtime effect: this is the removal of code nothing can reach.

### Changes

* **`lib/electronApp.js` — `ensureDeps()` removed in full** (JSDoc, body, and both `@ts-expect-error` suppressions): 23 deletions, 0 insertions, one hunk. No imports were orphaned — the body referenced only `this.log`, `this.$.utils.exists`, `this.$.env.paths.electronApp.nodeModules`, `this.$.env.stdio` and the missing `this.runNpm`. `linkNpmPackages` and `ensureMeteorDependencies` are untouched. The `@ts-expect-error` total drops **15 → 13** (seed-referenced **10 → 8**), counted over the same path list the `lint` script uses (`lib scaffold skeleton tests`), after confirming `scaffold/` and `lib/bin/` hold none of them.
* **Deleted rather than routed to `meteorApp.runNpm`**, which was the other option in the seed. The work is already done on every build by `electronApp.js:362` `rebuildDeps(true)` → `electronBuilder.installOrRebuild(arch, undefined, true)` → app-builder-lib's `installOrRebuild` with `appDir`/`projectDir` both set to the electron app root. Routing would have put a second, drifting npm installer on that same directory — the exact duplication Rule 31 exists to stop. The only behaviour `ensureDeps` had that today's path does not literally perform is `npm prune`, and nothing has run this code since 2018-03 while 6.0.x has shipped fine, so there is no observed state a prune would fix (Rule 6).
* **The v6.0.26 entry below is left as written.** It records "15 total: 10 seed-referenced" and named this seed as filed-not-fixed; that was accurate at v6.0.26 and amending it would rewrite history.

### Verification (Rule 27/41/48/57)

* **Instrumented before deleting, not reasoned about.** The real prototype body was executed against a minimal `this`: `ElectronApp.prototype.runNpm` is `undefined`, and both branches (`node_modules` present and absent) threw `Error: TypeError: this.runNpm is not a function`. The inner `TypeError` is raised synchronously inside the `try`, so the surrounding `catch (e) { throw new Error(e) }` wraps it and the stack points at `ensureDeps` rather than at the failing call.
* **Zero call sites**, per-repo across `meteor-desktop`, `frontend`, `test2`, `admin`, `octopussy`, `e2e`, `lambda-functions`, `frontend-static` and `ai-ceo`: only the definition and one CHANGELOG line. No dynamic dispatch on `$.electronApp`, no subclassing (`lib/index.js:46` is the sole instantiation), and none of `init`/`build`/`run`/`buildInstaller`/`runPackager`/`justRun` reaches it.
* **The type-check gate was inversion-tested, not assumed**: injecting a stray `@ts-expect-error` produced `TS2578 Unused '@ts-expect-error' directive` with exit 2; removing it returned the run to exit 0. So a directive left behind by mistake could not have passed silently. `lint` and `checkjs` clean before and after; `234 passing`, 0 failing (the 228 in the v6.0.26 entry predates `ebc2d79` + `be08d4b`, which added 6 cases and removed none).
* **Consumer-end (Rule 48), both paths.** Production: `npm run desktop build` from `frontend/` exited 0 with the full gate line — `A7 build summary: gates passed: A4 desktop.asar content, A2 bundle structure, A2.5 hash coherence, injectIsDesktop, A2.6 runtime-config URLs, A3 meteor asar, A3.5 manifest-asset coherence` — and the packaged app launched (main window shown, startup 2726 ms; renderer at `meteor://desktop/` complete, `Meteor.isDesktop === true`, `Desktop` and `WebAppLocalServer` bridges live). Dev: traversed the entire dependency region (node_modules install from electron-builder → `@electron/rebuild` x64 → native modules rebuild → `desktop.asar` validation, 24 files → A4 validation) and stopped only at `acquiring index.html` with `ECONNREFUSED 127.0.0.1:3000`, the documented abort without a Meteor dev server. **Neither build log contains `ensureDeps`** — both runs walked through the exact region where it used to be called, logging the replacement mechanism in its place and never the `installing dependencies` line `ensureDeps` opens with. That is the deadness claim tested at runtime rather than by grep.
* **Method note worth keeping.** An earlier version of that cross-repo sweep was run as a single recursive `grep -rn … .` from the workspace root. That form silently matches nothing across the nested sub-repos and returns a clean-looking zero for a string that definitely exists — and `--no-ignore` does not rescue it; only explicit per-repo directory arguments do. It was caught by pushing a **positive control** (a symbol known to be present) through the same command and watching the control come back empty too. A broken sweep and a true absence are byte-identical without that control.
* Plan adversarially reviewed on GLM 5.2 via Z.ai before implementation (verdict: sound with fixes); both should-fix items and the nit were adopted.

## v6.0.29 <sup>10.08.2026</sup>

*(Entry written retrospectively on 14.08.2026 from the commits — this release shipped without a CHANGELOG entry.)*

### Bug Fixes

* **`autoupdate` byte-progress summed the wrong field, so every download reported `0/0` bytes for its whole duration (`be08d4b`).** `assetManifest.js` parses the manifest entry's `size`, but `assetBundle.js`'s `Asset` constructor stores it as `this.entrySize` (`assetBundle.js:29`) — and `missingAssets` holds `Asset` objects, not manifest entries, so both `bytesTotal` and `bytesTransferred` summed `undefined`. The size-verification check further down the same file (`asset.entrySize !== body.length`) already had it right, which makes this a one-hop-too-few trace rather than an unknown. **Measured end-to-end** on a real HCP download from a packaged build against a live Meteor server, sampled in the renderer: `downloading 0/0 100%` before, `downloading 4351/492337 1%` → `downloading 492337/492337 100%` after, with 492337 checking out against the served manifest (whose entries sum to 8063253 for the full bundle — the download is the missing subset). Adds the coverage whose absence let it ship: `assetBundleDownloader.test.js` had no test touching `bytesTotal`, `onProgress` or `size` at all. Three cases now, one of which pins the field name from the other side (a raw manifest-entry shape must **not** contribute, so the fix cannot be "simplified" back by changing a fixture). Inversion-verified: restoring `asset.size` fails 3 of them.

### Changes

* **Regression test for the v6.0.27 teardown guard (`ebc2d79`, seed `frontend-44cb`).** The guard shipped but had never been exercised — the failure path was only ever reasoned about. It lives in `tests/unit/skeleton/app.test.js` rather than the consumer's e2e suite because racing `app.exit(0)` against a late `startupDidComplete` IPC from Playwright would be flaky and prove less than calling the method with the window already gone. Three cases: a late `startupDidComplete` with `this.window === null` must not throw, must warn, and must not run anything downstream; the same via `did-stop-loading`, the *other* producer of that call; and a normal startup must still reach `window.show()`/`focus()` — without which deleting the whole method body would pass the first two. **Inversion verified, not assumed**: with the `if (!this.window)` guard removed the suite goes `14 passing` → `12 passing / 2 failing`, both with `TypeError: Cannot read properties of null` — the exact error a win32 5.2.2 user hit.

## v6.0.28 <sup>09.08.2026</sup>

*(Entry written retrospectively on 14.08.2026 from the commits — this release shipped without a CHANGELOG entry.)*

**HCP download started/progress events, so a Meteor app can show an update and block on it (`6db6667`).** Until now the only renderer-facing HCP signal was `onNewVersionReady`, which fires when the whole bundle has **already** landed. A consuming app therefore could not distinguish "no update" from "downloading 40MB over a slow link", had nothing to show the user, and nothing to block interaction on — the consumer symptom being a bundle applying mid passwordless-login and resetting the form or landing on a single-use token (`frontend-dac7`). Byte-accurate rather than a file count: manifest entries already carry `size`, so the downloader sums the missing assets up front and reports real bytes.

### Changes

* **`assetBundleDownloader`** — optional `onProgress(bytesTransferred, bytesTotal)` beside the existing `onFinished`/`onFailure`. The total is summed in the **constructor**, because `missingAssets` is spliced as assets land and by completion the array is empty and the total unrecoverable. Progress fires after verification and write, not on response arrival, so it can never run ahead of a download that then fails verification.
* **`assetBundleManager`** — forwards progress, and calls `onDownloadStarted(bytesTotal)` only once a download is actually committed to: placed after the all-assets-cached short-circuit and after `shouldDownloadBundleForManifest`, because a consumer that blocks its UI on a download that never starts would hang the app (blacklisted versions being the obvious case).
* **`autoupdate`** — implements both callbacks, forwarding to the renderer via `module.send` and to the main process via `eventsBus`, mirroring `notifyNewVersionReady`. **`desktop-hcp`** — exposes `WebAppLocalServer.onDownloadStarted`/`onDownloadProgress`, mirroring the existing `onNewVersionReady` bridge.
* **All additive**: `onProgress` is optional and the two new callbacks are feature-detected on the manager's callback object, so an existing consumer is unaffected. (Note: the byte totals were wrong on arrival — see the `be08d4b` fix in v6.0.29.)

## v6.0.27 <sup>08.08.2026</sup>

*(Entry written retrospectively on 14.08.2026 from the commits — this release shipped without a CHANGELOG entry.)*

### Bug Fixes

* **Survive a `startupDidComplete` IPC that lands during teardown (`0fa746a`, escalation ESC-0005 / seed `frontend-0144`).** `handleAppStartup` dereferenced `this.window` unguarded. `this.window` is nulled by the window's own `'closed'` handler in `onServerReady`, and **both** producers of `handleAppStartup` are asynchronous — the `startupDidComplete` IPC registered in the constructor, and webContents `'did-stop-loading'`. Electron does not guarantee a queued IPC is dropped between window destruction and process exit, so a renderer reporting startup completion while the app quits crashed the main process on `this.window.show()`. **Measured on a 5.2.2 win32 client 2026-08-07**: the host app's startup watchdog gave up at 14:13:04.842 and called `app.exit(0)`; the renderer reached `Meteor.startup` 1.179 s later and sent the IPC into a dead window. Returning early is safe — `beforeLoadFinish` and `loadingFinished` have **zero** listeners across `skeleton/`, `lib/`, the consumer's `.desktop/`, and `meteor-desktop-splash-screen` (whose only `eventsBus` listener is `windowCreated`) — whereas `updateToNewVersion()` would have restarted the local HTTP server while the app was shutting down.
* **`autoupdate` held its own window reference**, set once on `windowCreated` and never cleared, so a startup-timer expiry after teardown called `reload()` on a destroyed `BrowserWindow`. Now nulled on `'closed'` (mirroring `skeleton/app.js`), with a window required before the revert reload. That path becomes reachable for the first time once the consumer's watchdog stops killing the app before `webAppStartupTimeout` elapses.

### Changes

* **CI is now the single publisher (`5e01cf9`, seed `meteor-desktop-cfe7`).** `postversion` ran `npm publish` from the dev machine **before** pushing the tag, so by the time the tag push triggered `publish.yml`, CI's own `npm publish` hit "You cannot publish over the previously published versions" and exited 1 — and "Create GitHub Release" is the last step in that job, so it never ran. **Measured 2026-08-07: 12 of 12 `publish.yml` runs had failed since v6.0.14 (2026-05-25)**, GitHub Releases were stuck at v6.0.7 while master and the pushed tags were both at 6.0.26, and no published version carried provenance (`npm view @a4xrbj1/meteor-desktop@6.0.26 dist.attestations` empty), because the only publish that would attest under OIDC is the one that always failed. `postversion` now only pushes the tag; `publish.yml` does npm with OIDC provenance, GitHub Packages, then the Release, as one job that fails loudly if any part fails. `publish-npm` deleted as orphaned by the change. **Not fixed there**: `publish-npm-preview` still publishes locally and pushes tags, so a preview release would re-trigger the same collision — tracked in the seed.

## v6.0.26 <sup>27.07.2026</sup>

**Dev-tooling only: `checkjs` (tsc type-check) added and the repo wired into the workspace post-edit lint/tsc gate (seed `workspace-cf82`).** This batch alone would not have warranted a publish — it rides this release because the HCP `User-Agent` fix below is a shipped runtime change: `jsconfig.json`, `types/*.d.ts`, `.gitignore` and devDeps are not in `package.json#files`, and the `checkjs` script key is inert for consumers — the published artifact is unaffected except for type-level comment edits in shipped `lib/`/`scaffold/`/`skeleton/` files (see the tail-drive entry below), which ride the same deferred consumer-exercise gate as the fbee batch (v6.0.20 notes).

**Send a modern `User-Agent` on both HCP requests — hot code push was aborting on every desktop update with `sri mismatch for asset: packages/modules.js` (seed `frontend-7c13`).** Meteor picks the client arch from the request's User-Agent (`modern-browsers`), and `checkForUpdates()` fetches its manifest from the hardcoded **modern** endpoint `__browser/manifest.json` (`skeleton/modules/autoupdate/assetBundleManager.js:84`) — but neither that request (`:88`) nor the asset requests (`skeleton/modules/autoupdate/assetBundleDownloader.js:160`) sent a `User-Agent` at all, so the manifest was `web.browser` while every asset came back `web.browser.legacy`. The two arches genuinely differ for `packages/modules.js` (`@meteorjs/rspack` emits it un-minified — seed `meteor-desktop-1d08`), so `verifyResponse` rejected the bundle and the app stayed silently on its baked version: JS-only updates could never land on desktop. Fail-safe, but total. Measured on staging, same URL: **546244** bytes with no UA (and with curl's default UA) vs the manifest's **471826** with any `Chrome/<ver>` UA — and the legacy sha512 was byte-for-byte the digest the failing app reported receiving. Not a regression from any one release: the manifest endpoint has been pinned to `__browser` and the requests UA-less all along, which is also why seed `meteor-desktop-1d08`'s "served sri == served bytes (Chrome UA)" gate could not surface it — a Chrome UA selects the arch the downloader never gets.

### Bug Fixes

* **`skeleton/modules/autoupdate/utils.js` — new exported `modernUserAgent`**: `Mozilla/5.0 (<process.platform>) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<process.versions.chrome> meteor-desktop-hcp Safari/537.36`. Built from the Chromium the app actually runs on (always set in the Electron main process; the `120.0.0.0` fallback only applies to plain-node use), and self-identifying in server logs. Measured against staging: `modern-browsers` only needs the `Chrome/<ver>` token — 136, 138 and 999 all select `web.browser`, as does the real Electron renderer UA; no UA and curl's default select `web.browser.legacy`.
* **Both HCP requests now send it** — `assetBundleManager.checkForUpdates()` and `assetBundleDownloader.resume()`, alongside the existing `Connection: close`. The manifest request is UA-independent today (the `/__browser/` path prefix wins — verified: byte-identical manifest with and without a UA), but it is sent on both so the pair can never disagree about arch again.
* **Deliberately not fixed by prefixing the asset URLs with `/__browser/`** (candidate (b) in the seed, and it does work — measured). That is exactly what `skeleton/app.js:766-774` already documents as breaking rspack dynamic chunks: Meteor's SPA catch-all answers `/__browser/<chunk>` with HTML, which surfaces as `Uncaught SyntaxError: Unexpected token <`. The UA moves every asset path at once without touching a single URL.
* **Who was affected — measured, and it is narrower than the seed assumed, but not by anything the app controls.** The defect needs a server that deploys **both** web arches. A UA-less sweep of every sri-bearing asset gave **73/73 match on `app.yourdna.family`** (single arch: `autoupdate.versions` lists only `web.browser`, `/__browser.legacy/manifest.json` returns the SPA fallback) versus **41 of 72 mismatching on `app-staging.yourdna.family`** (both arches deployed) — so it was never only `packages/modules.js`, and prod HCP could not fail this way as prod is deployed today. That immunity is not a property of the app: Meteor 3.5 hardcodes both arches (`meteor-tool/3.5.0/tools/project-context.js:1280-1287`), `meteor build` ignores `modern.webArchOnly` (`cli/commands.js:338-350` — it only applies in dev/test), the consuming app explicitly sets `"webArchOnly": false`, and nothing in that app's repo or history excludes the legacy arch — its own committed deploy script produces the two-arch shape that broke staging. Prod's single-arch state comes from an external builder default, so this fix is what makes the topology irrelevant. Mechanism, for the record: `webapp/2.2.0/os/webapp_server.js:188-200` ranks a non-modern UA `['web.browser.legacy','web.browser']` and only falls through to modern when no legacy program is registered. Also worth knowing: only 73 of ~311 downloaded items carry an `sri` at all, so on a dual-arch server this class of defect is caught by a minority of entries and wrong-arch bytes for the rest (images, chunks, source maps) would be accepted on a `200` alone.
* **Precision on the trigger**: the code set no `User-Agent`, but the request was not header-less on the wire — `globalThis.fetch` (undici) supplies `user-agent: node`, which `modern-browsers` classifies non-modern, hence the legacy arch. Same outcome, and the fix is unchanged; noted so nobody debugging the wire looks for an absent header.

### Verification (Rule 41/48/56/57)

* **Symptom reproduced, then killed, with the real production classes against the real server.** A harness drove unmodified `AssetManifest` + `AssetBundle` + `AssetBundleDownloader` (imported from `skeleton/`) against `https://app-staging.yourdna.family/`: at `HEAD` it failed with the seed's exact error — `failed at verifyResponse: sri mismatch for asset: packages/modules.js - expected sha512: D+nMDvt6… != ZCTGGcnVuUPf…` — and with the fix the same asset verified and landed on disk at 471826 bytes. **Full bundle: all 458 assets** (427 manifest entries + source maps + `index.html`, whose `verifyRuntimeConfig` now sees the modern index) downloaded and verified in 35.5 s with no failure of any kind, so `modules.js` was not hiding a second divergent asset class.
* **Unit test + inversion**: `tests/unit/skeleton/assetBundleDownloader.test.js` → `AssetBundleDownloader request headers` asserts `resume()` sends `User-Agent: … Chrome/<ver> …` and still sends `Connection: close`; removing the header from the call site fails it (`expected undefined to match / Chrome\/\d[\d.]* /`). `228 passing` (227 + 1 new); `npm run lint` and `npm run checkjs` clean.
* **Consumer-end (Rule 48)**: with the three changed files copied into `frontend/node_modules/@a4xrbj1/meteor-desktop`, `npm run desktop build` from `frontend/` completed green — `A7 build summary: gates passed: A4 desktop.asar content, A2 bundle structure, A2.5 hash coherence, injectIsDesktop, A2.6 runtime-config URLs, A3 meteor asar, A3.5 manifest-asset coherence` — and both call sites are present in the packaged, minified `app.asar` (`modules/autoupdate/assetBundleDownloader.js`, `…/assetBundleManager.js`: `{headers:{Connection:"close","User-Agent":modernUserAgent}}`).
* **Observed on the wire from the real packaged Electron app.** Launched the production build against a local listener that logs request headers; the app booted (window shown, startup 858 ms, no module-load error) and its HCP request arrived as `GET /__browser/manifest.json` with `user-agent: Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.271 meteor-desktop-hcp Safari/537.36` and `connection: close` — so `process.versions.chrome` resolves to the real Chromium (148, not the `120.0.0.0` fallback), the existing header survived, and the downloader now presents the same modern arch as the renderer's own UA (`… yourDNA.family/5.2.1 Chrome/148.0.7778.271 Electron/42.5.2 …`) in the same run.
* **The dev consumer run (`npm run desktop`) is deferred**: it requires a Meteor dev server on `:3000` and aborts at `acquiring index.html` without one. It did complete the whole desktop packaging phase with the fix in place (skeleton copy → `@electron/rebuild` → `desktop.asar` pack + A4 validation) before that point. `meteor-desktop just-run`, which would have launched the built app through the CLI, is broken independently of this change (`TypeError: Cannot read properties of undefined (reading 'dependency')` at `lib/electron.js:37`) — filed as seed `meteor-desktop-86d2`; the Electron launch above therefore invoked the electron binary on the build dir directly.
* **End-to-end in the real app against real staging — HCP now lands, which it never had.** Built an isolated staging desktop app (`frontend/scripts/desktop-staging.sh`, `SKIP_SIGN=1` — own appId/productName/userData, baked `ROOT_URL=https://app-staging.yourdna.family/` per the A2.6 gate, so the prod app's HCP store is untouched) with the fix in `node_modules`, and compared it against the same app's pre-fix run from earlier the same day:
  * **before** (`~/Library/Application Support/yourDNA.family-staging/`, 6.0.25): `versions/` held only `Downloading` + `PartialDownload`, `autoupdate.json.lastDownloadedVersion: null`, and two `download failure: failed at verifyResponse: sri mismatch for asset: packages/modules.js` entries.
  * **after**: `finished downloading new asset bundle version:00b47b87…` → `received newVersionReady` → `versions/00b47b87…/` complete (62 files — only the assets that differ from the baked bundle; the rest are shared with the parent), `lastDownloadedVersion: 00b47b87…`, and the delivered `packages/modules.js` is **471826 bytes** on disk — the modern arch, exactly the manifest's `size`. Zero sri / hash / `verifyRuntimeConfig` failures in the run.
  * **after restart**: `will use last downloaded version (00b47b87…)` → `startup did complete (353ms)` → `lastKnownGoodVersion` advanced to `00b47b87…`, `blacklistedVersions: []`, then `skipping downloading current version` (steady state, no re-download loop). The live renderer over CDP: `autoupdate.versions['web.browser'].version = 00b47b87…` — **flipped off the baked `c79f63bf…` onto the server's version, which is exactly the acceptance criterion in seed `frontend-7c13`** — with `DDP_DEFAULT_CONNECTION_URL` present, `Meteor.status() === 'connected'`, `Meteor.isDesktop === true`, and the real login UI rendered (18653 chars) — i.e. no repeat of the `meteor-desktop-hcp-brick` white-screen, and the isDesktop injection survived the HCP rewrite.
* **Prod is unverified**, per the seed: the mechanism (UA-less requests + a modern-only manifest endpoint) is identical there, but confirming it needs a probe of `app.yourdna.family`, which was out of scope.

### Changes

* **`npm run checkjs`** (`node_modules/.bin/tsc -p jsconfig.json --noEmit`) — same command as admin/e2e. Phase-0 `jsconfig.json` knobs collapse the check from 10,772 reported errors to a 158-error own-source tail: explicit `"strict": false` (TypeScript 6 flipped the default; ~6,700 implicit-any findings were noise for un-annotated JS), `"maxNodeModuleJsDepth": 0` (stops tsc type-checking untyped node_modules JS — 7,484 errors in sinon/chai/async/fs-plus sources; packages with real `.d.ts` still resolve), `"skipLibCheck": true`, `"types": ["node", "mocha"]` (new direct devDeps `@types/node` ^24.13.3 — previously only transitive — and `@types/mocha` ^10.0.10), `"paths"` redirecting the two intentionally-not-installed modules (`electron` — consumer-provided; `@playwright/test` — installed into the consumer project by `lib/bin/cli.js`) to `types/loose-any.d.ts`, and `tests/fixtures` excluded (bundled `packages/meteor.js` copies).
* **`types/ambient.d.ts` + `types/loose-any.d.ts`** — script-form ambient stubs for the runtime-injected skeleton globals (`WebAppLocalServer`, `Desktop`, `Meteor`, `window.Package`) and the cross-file JSDoc type refs tsc can't resolve (`MeteorDesktop`, `App`, `Asset`, `AssetBundle`, …); admin/e2e pattern, type-only, zero runtime effect.
* **`.gitignore` += `*.tsbuildinfo`** — the post-edit hook runs tsc with `--incremental`, which writes `jsconfig.tsbuildinfo` at the repo root (e2e `021d1e5` precedent). Note: after any future `jsconfig.json` change, delete `jsconfig.tsbuildinfo` once — stale incremental state can under-report.
* **Drove the checkJs tail 158 → 0** so the type-check gate is clean signal. All shipped `lib/`/`scaffold/`/`skeleton/` edits are type-level or runtime-identical: `'UTF-8'` → `'utf-8'` (48 sites; Node accepts both, `@types/node` types only lowercase), corrected JSDoc `@returns`/`@param` (`{[]}` empty-tuple → `Object[]`, `{string}` on `async` → `Promise<…>`, `{bool}` → `{boolean}`, destructured-param docs, two stale `env.js` path typedefs — `appRoot` was mis-declared as an object, `packagePaths` was missing `cache`/`installerDir`), `{ isPack: false }` on `asar.listPackage` (upstream d.ts requires the option), progressive-build `/** @type {…} */ ({})` assertion casts, and a genuine (benign) fix in `skeleton/app.js` — `'utf-8'` was misplaced as `JSON.parse`'s reviver instead of `readFileSync`'s encoding. `227 passing` (unchanged), `node --check` clean on all 34 changed files.
* **Suspected latent bugs surfaced by the type-check are filed as seeds, not silently fixed** (Rule 26): `ensureDeps()` calls a non-existent `this.runNpm` (`meteor-desktop-3129`); `preload` `fetchFile`/`fetchAsset` pass a vestigial 2nd arg (`meteor-desktop-ab39`); `assetBundleManager` caller/doc drift on a removed `isInitialAssetBundle` param (`meteor-desktop-566b`); autoupdate test-helper `MeteorServer`/`init` signature drift (`meteor-desktop-c1f9`). Each is suppressed with a `@ts-expect-error` carrying the seed id (15 total: 10 seed-referenced, 5 for tests that intentionally exercise `@private` members).
* **CI: `publish.yml` npm publish moved from a long-lived `NPM_TOKEN` secret to npm Trusted Publishing (OIDC) — seed `meteor-desktop-cfe7`.** The `NPM_TOKEN` secret expired between 2026-05-19 (v6.0.8 still got the informative `E403 "cannot publish over previously published versions"` — token valid) and 2026-05-25 (v6.0.14 onward got the opaque `E404 "…could not be found or you do not have permission"` — token unauthorized); every release from v6.0.8 to v6.0.25 was published manually. Fix: add `id-token: write`, ensure `npm ≥ 11.5.1` (`npm install -g npm@latest`), and drop the `NODE_AUTH_TOKEN`/`NPM_TOKEN` wiring from the npm step so `npm publish` uses the OIDC exchange (no expiring credential; provenance attested automatically). **Requires a one-time Trusted Publisher config on npmjs.org** for repo `a4xrbj1/meteor-desktop` + workflow `publish.yml` before the next tag push. The GitHub Packages publish (via `GITHUB_TOKEN`) is unchanged.
* **CI: `publish.yml` bumped `actions/checkout@v4 → @v5` and `actions/setup-node@v4 → @v5`** — both v5 majors declare the Node 24 action runtime natively, clearing the "Node.js 20 is deprecated" annotation for those two. `softprops/action-gh-release@v2` has no node24 release yet, so it stays on v2 and `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` is retained to force it onto Node 24 ahead of GitHub's node20 runtime removal (~2026-09-16). Bare/param-compatible usage, so the majors are drop-in.

## v6.0.25 <sup>15.07.2026</sup>

**Null-guard the `autoupdate` `'error'` bridge callback in `skeleton/desktop-hcp.js` — fixes the intermittent `"WebAppLocalServer.onErrorCallback is not a function"` TypeError (e2e-2589 / seed `meteor-desktop-a5e5`).** The `Desktop.on('autoupdate', 'error', …)` bridge handler called `WebAppLocalServer.onErrorCallback(args)` unconditionally, unlike its two sibling handlers (`onVersionsCleanedUp`, `onNewVersionReady`) which null-guard their callbacks. `onErrorCallback` is only registered inside `start()`, run in `Meteor.startup(start)` — so an autoupdate `'error'` emitted in the window between module-load (bridge live) and `Meteor.startup` (sink registered) called `null(args)` and threw. Prod-latent (needs an early `checkForUpdates` / `verifyRuntimeConfig` failure before startup); reliably reproduced in the YDF e2e harness, where the ROOT_URL-mismatch `verifyRuntimeConfig` failure fires early and full-suite load delays `Meteor.startup`, widening the window.

**Raise the Node floor `>=22.22.0` → `>=24.15.0` to match the Node bundled by MeteorJS 3.5.** meteor-desktop runs inside the Meteor toolchain (`meteor build` / `npm run desktop`), so the runtime it actually executes under is Meteor's bundled Node — 24.15.0 for Meteor 3.5. `engines` is a floor, not a cap: no dependency in the tree carries an upper-bound `engines.node`, so this does not forbid newer lines (24.x, 26.x). CI updated for parity: `test.yml` `22.22.0` → `24.15.0`, `publish.yml` `22` → `24`.

### Bug Fixes

* **`skeleton/desktop-hcp.js` — guard the `'error'` bridge callback and `console.warn` the cause when the sink is not yet registered.** The error is still surfaced (never dropped) but no longer crashes when it arrives before `Meteor.startup`, matching the sibling-handler pattern. Unit test in `tests/unit/skeleton/desktopHcpBootstrap.test.js` reproduces the exact race (`Meteor.startup` captured but not run) and asserts no throw + the warn; without the guard its `.to.not.throw()` assertion fails (inversion, Rule 41). `desktopHcpBootstrap`: 6 passing; eslint clean.

### Changes

* **`package.json` `engines.node` `>=22.22.0` → `>=24.15.0`.** Documents the real runtime (Meteor 3.5 bundled Node); still a floor, so consumers on any Node ≥ 24.15.0 are unaffected.
* **CI Node pins bumped to 24.15.0** (`.github/workflows/test.yml`, `publish.yml`) so the suite no longer runs below the declared floor.

## v6.0.24 <sup>10.07.2026</sup>

**Stop the desktop renderer from evaluating the client bundle TWICE — the root of the "login screen re-appears after the security token is pasted" incident (2026-07-10, frontend).** Under `@meteorjs/rspack` v2 the Meteor bundle (`app/app.js`) bundles the compiled client graph as a module **and** executes it via `module.link('./client-rspack.js')` — web production ships `/app.js` alone and runs the whole app. But meteor-desktop's `injectEsm` (PATCH 2b) *also* injected a standalone `<script src="/__rspack__/client-rspack.js">` into `index.html`, so the renderer evaluated the **entire** client bundle a second time. Observed on prod 5.1.9 via DataDog: every client marker in duplicate pairs, two `[remoteAuth] calling login on test2`, two `test2_login_arrived` — and, user-visibly, the Login Svelte component remounting and resetting to the first (email) step the instant a passwordless token completed. (The double execution is itself proof that `/app.js` runs the graph independently — otherwise there would be nothing to duplicate — so dropping the second tag is safe.)

**Producer, precisely.** Not `reconcileIndexHtmlScriptsWithManifest` — a build log proves reconcile reads the on-disk `web.browser/program.json` (70 js entries, **no** rspack entry) and rewrites `70 → 70`. `injectEsm` adds the `/__rspack__/client-rspack.js` `<script>` tag (line ~1842) and its manifest entry (line ~1907) *after* reconcile. That is the only writer of the redundant tag.

### Bug Fixes

* **`lib/meteorApp.js` `injectEsm` — skip the redundant `<script src="/__rspack__/client-rspack.js">` when the Meteor bundle already links the graph.** Before injecting the eager tag, read the on-disk Meteor bundle (`app/app.js`, root `app.js` fallback) and test for `module.link('./client-rspack.js')`; if present, the graph is already loaded via `/app.js`, so the tag is skipped (logged: `injectEsm: skipped redundant /__rspack__/client-rspack.js <script> …`). If the Meteor bundle does **not** link it (older pipelines where `app.js` is a thin shim), the tag is injected exactly as before, so no capability is lost. The `client-rspack.js` file, its lazy chunks, and its manifest entry are untouched — chunk loading and the A3.5 real-bundle gate are unaffected; only the redundant eager execution is removed.

### Verification (Rule 41/56/57)

Unit: `tests/unit/meteorApp.test.js` gains two `#injectEsm` cases — the tag is skipped when `app/app.js` links the graph, and injected when it is a thin shim; full `meteorApp` suite 33 passing, and an inversion check confirms the skip test fails when the detector is neutralized. Consumer end-to-end (Rule 48/56): a real `npm run desktop build` (frontend, Electron 42.5.2) run against the patched package — A7 gates all pass, the build log shows `injectEsm: skipped redundant /__rspack__/client-rspack.js <script>`, and the produced `meteor.asar`'s `index.html` carries **exactly one** graph tag (`/app.js`) and **zero** `client-rspack.js` tags, while the `client-rspack.js` file and manifest entry remain for lazy chunks. Refutation checks (Rule 57): confirmed the file is still in the asar, the manifest still lists it (A3.5 coherent), and reconcile's own `70 → 70` line is unchanged (proving the fix is in the right producer). Prior wrong attempt at `reconcileIndexHtmlScriptsWithManifest` was reverted when the first real build printed `70 → 70` with no drop — the isolated-function test had passed while the real pipeline did not (exactly the failure mode Rule 56 exists to catch).

## v6.0.23 <sup>02.07.2026</sup>

### Changes

* **Recommended Electron bumped `40.8.3` → `42.5.2` (`lib/defaultDependencies.js`).** Electron 40 reached EOL 2026-06-30 (no further Chromium security patches). This is the version `getDependency` recommends (mismatch warning) and auto-installs into a consumer app that has no `electron` devDependency; consumers pinning their own version are unaffected beyond the warning now aligning with 42.x. Note Electron 42 removed the npm `postinstall` binary download — the binary now downloads on first `require('electron')`/run (`install.js` still exists for explicit fetching). Consumer exercise (Rule 48): frontend `npm run desktop` dev launch + prod `npm run desktop build` on electron 42.5.2 as part of the frontend electron-42 upgrade (seed `frontend-5da0`).

## v6.0.22 <sup>20.06.2026</sup>

**Fix the e490 web-HCP stuck-splash brick — a downloaded server bundle never boots Meteor in the `meteor://` renderer (seed `meteor-desktop-hcp-brick`).** v6.0.20's Stage 1 (e490) made the desktop DOWNLOAD + APPLY a web-HCP bundle, but the *applied* bundle could not boot: an HCP update reset to it, the renderer white-screened, the splash never cleared, and the 5-minute startup timer reverted in a loop (revert → re-apply → timeout) — the app sat on the tiny update splash forever. Diagnosed live with the renderer debugger (CDP) on a real bricked install, not from logs alone.

**Root cause.** The HCP-downloaded bundle is the server's *plain web* build: its `__meteor_runtime_config__` ships **without `DDP_DEFAULT_CONNECTION_URL`** (a Meteor server injects that per request; only `ROOT_URL` is baked into the static bundle) and **without the desktop-hcp loader** (`<script src="/cordova.js">`). meteor-desktop's *embedded* build bakes both in, so it is immune — but the production `meteor://` serve path (`skeleton/app.js`) returned the downloaded HTML unmodified (the DDP/ROOT_URL patch + loader injection were gated behind dev mode only). With no `DDP_DEFAULT_CONNECTION_URL`, Meteor's default DDP connection resolves relative to the page origin `meteor://desktop` → SockJS throws *"The URL's scheme must be either 'http:' or 'https:'. 'meteor:' is not allowed"* during module evaluation (`ddp-client` connects at link time) → the uncaught error aborts the module-loading chain, so `meteorInstall`/`Meteor` never finish → white screen. With no loader, `desktop-hcp.js` (which fires `startupDidComplete`) never runs, so even a booted bundle would not cancel the revert timer. Observed exception chain: `modules.js#moduleLink → ddp-client → DDP.connect → new ClientStream → SyntaxError('meteor:' not allowed)`, then `meteorInstall is not defined` at `app.js:1`.

### Bug Fixes

* **`skeleton/app.js` — re-add `DDP_DEFAULT_CONNECTION_URL` + the desktop-hcp loader to every served bundle in production.** The `meteor://` protocol handler now, for production HTML serves (the dev branch is unchanged), injects a tiny inline script right after the `__meteor_runtime_config__` assignment that sets `DDP_DEFAULT_CONNECTION_URL = ROOT_URL` when the bundle omits it (so DDP connects to the real server, not `meteor://`), and injects `<script src="/cordova.js">` (the `/desktop-hcp.js` alias) before the first Meteor script when absent. Both are **no-ops when already present**, so the embedded bundle — which bakes both in — is untouched; only HCP-downloaded bundles are repaired.
* **`skeleton/desktop-hcp.js` — fire `startupDidComplete` on `Meteor.startup`.** The stock `cordova-plugin-meteor-webapp` call that fires `startupDidComplete` exists only in the embedded build's JS, never in the server's plain web bundle, so a downloaded bundle could not signal startup completion. The e490 renderer bootstrap now calls `WebAppLocalServer.startupDidComplete()` from inside its `Meteor.startup` hook — an accurate "this version booted" signal that cancels the revert timer and closes the splash for downloaded bundles. A genuinely broken bundle never reaches `Meteor.startup`, so the bad-version revert safety is preserved; the embedded build double-fires harmlessly (`startupDidComplete` is idempotent).

### Verification (Rule 48/56)

End-to-end on the **real bricked machine** (not an isolated test): the fix (transpiled to CommonJS exactly as the build does, hot-swapped into the installed app's `app.asar`/`meteor.asar`) was run against live `app.yourdna.family`. Before: the HCP reset to the downloaded bundle (`62f8…`) white-screened (`meteorInstall is not defined`), the startup timer expired, and it reverted in a loop. After: the same reset boots the downloaded bundle — `Meteor`/`WebAppLocalServer`/`meteorInstall` all defined, DOM rendered, `startupDidComplete` fires after the reset, **zero** timer-expiries/reverts, the splash closes, and the app serves the downloaded `62f8…` bundle as a live app. Lint (`eslint skeleton/app.js skeleton/desktop-hcp.js`) clean.

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
