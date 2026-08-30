/**
 * Historical name — this file defines WebAppLocalServer for Meteor's standard web HCP.
 * Based on: https://github.com/meteor/cordova-plugin-meteor-webapp/blob/master/www/webapp_local_server.js
 */

// eslint-disable-next-line no-global-assign
WebAppLocalServer = {
    onNewVersionReadyCallback: null,
    onErrorCallback: null,
    onVersionsCleanedUpCallback: null,
    onDownloadStartedCallback: null,
    onDownloadProgressCallback: null,
    onNativeUpdateRequiredCallback: null,
    onUpdateCheckStartedCallback: null,
    onUpdateNotAvailableCallback: null,
    onDownloadAlreadyInProgressCallback: null,

    startupDidComplete(callback) {
        this.onVersionsCleanedUpCallback = callback;
        Desktop.send('autoupdate', 'startupDidComplete');
    },

    checkForUpdates() {
        Desktop.send('autoupdate', 'checkForUpdates');
    },

    onNewVersionReady(callback) {
        this.onNewVersionReadyCallback = callback;
    },

    // Download lifecycle. Before these existed the only signal was onNewVersionReady, which
    // fires when the bundle has ALREADY landed — so a Meteor app could not distinguish "no
    // update" from "downloading over a slow link", and had nothing to show or block on.
    onDownloadStarted(callback) {
        this.onDownloadStartedCallback = callback;
    },

    onDownloadProgress(callback) {
        this.onDownloadProgressCallback = callback;
    },

    // Check lifecycle (seed meteor-desktop-5aa1). Every check now ends in exactly one observable
    // outcome: onUpdateCheckStarted, then one of onError / onUpdateNotAvailable /
    // onNativeUpdateRequired / onDownloadAlreadyInProgress / onDownloadStarted ->
    // onDownloadProgress -> onNewVersionReady. The
    // window between "asked" and "downloading" used to emit nothing, so a wedged check looked
    // exactly like a healthy idle app.
    onUpdateCheckStarted(callback) {
        this.onUpdateCheckStartedCallback = callback;
    },

    onUpdateNotAvailable(callback) {
        this.onUpdateNotAvailableCallback = callback;
    },

    // Fires when a poll lands while a download of that same version is already running (seed
    // meteor-desktop-912a). Routine on a slow link, where a bundle download outlasts the 10-minute
    // poll interval — not an error, and not a second download. Present so the branch has an
    // outcome at all; a check that starts and then says nothing is what a wedge looks like.
    onDownloadAlreadyInProgress(callback) {
        this.onDownloadAlreadyInProgressCallback = callback;
    },

    // Native-vs-JS update split (seed meteor-desktop-0a0e). Fires when the desktop side refused a
    // JS bundle because the installed native shell is older than the minimum the bundle declares,
    // with { version, required, installed }. Nothing in meteor-desktop acts on it — subscribe and
    // drive your own electron-updater check. Re-emitted on every 10-minute poll while the mismatch
    // stands, so debounce before showing UI.
    onNativeUpdateRequired(callback) {
        this.onNativeUpdateRequiredCallback = callback;
    },

    onError(callback) {
        this.onErrorCallback = callback;
    }
};

Desktop.on('autoupdate', 'error', (event, args) => {
    // Guard the callback like the onVersionsCleanedUp / onNewVersionReady handlers below do. This
    // bridge is live from module-load, but onErrorCallback is only registered later, inside
    // Meteor.startup(start) (onError, further down). An 'autoupdate' 'error' emitted in that window —
    // e.g. an early checkForUpdates / verifyRuntimeConfig failure before startup, made more likely
    // when startup is delayed under load — otherwise calls null(args) and throws
    // "WebAppLocalServer.onErrorCallback is not a function" (e2e-2589 / meteor-desktop-a5e5). Surface
    // the cause via console.warn when the sink is not yet registered, so the error is never dropped.
    if (WebAppLocalServer.onErrorCallback) {
        WebAppLocalServer.onErrorCallback(args);
    } else {
        console.warn('[meteor-desktop] autoupdate error before error sink registered:', args);
    }
});

Desktop.on('autoupdate', 'warn', (event, args) => {
    console.warn(args);
});

Desktop.on('autoupdate', 'onVersionsCleanedUp', () => {
    if (WebAppLocalServer.onVersionsCleanedUpCallback) {
        WebAppLocalServer.onVersionsCleanedUpCallback();
    }
});

Desktop.on('autoupdate', 'onDownloadStarted', (event, bytesTotal) => {
    if (WebAppLocalServer.onDownloadStartedCallback) {
        WebAppLocalServer.onDownloadStartedCallback(bytesTotal);
    }
});

Desktop.on('autoupdate', 'onDownloadProgress', (event, bytesTransferred, bytesTotal) => {
    if (WebAppLocalServer.onDownloadProgressCallback) {
        WebAppLocalServer.onDownloadProgressCallback(bytesTransferred, bytesTotal);
    }
});

Desktop.on('autoupdate', 'onUpdateCheckStarted', (event, rootUrl) => {
    if (WebAppLocalServer.onUpdateCheckStartedCallback) {
        WebAppLocalServer.onUpdateCheckStartedCallback(rootUrl);
    }
});

Desktop.on('autoupdate', 'onUpdateNotAvailable', (event, version) => {
    if (WebAppLocalServer.onUpdateNotAvailableCallback) {
        WebAppLocalServer.onUpdateNotAvailableCallback(version);
    }
});

Desktop.on('autoupdate', 'onNativeUpdateRequired', (event, args) => {
    if (WebAppLocalServer.onNativeUpdateRequiredCallback) {
        WebAppLocalServer.onNativeUpdateRequiredCallback(args);
    } else {
        console.warn('[meteor-desktop] HCP bundle needs a newer native shell:', args);
    }
});

Desktop.on('autoupdate', 'onDownloadAlreadyInProgress', (event, version) => {
    if (WebAppLocalServer.onDownloadAlreadyInProgressCallback) {
        WebAppLocalServer.onDownloadAlreadyInProgressCallback(version);
    }
});

Desktop.on('autoupdate', 'onNewVersionReady', (event, args) => {
    console.log('new version ready', args);
    if (WebAppLocalServer.onNewVersionReadyCallback) {
        WebAppLocalServer.onNewVersionReadyCallback(args);
    }
});

// Set the reference, so that the desktop side will be able to communicate with us asap.
Desktop.send('dummyModule', 'setRendererReference');

// ---------------------------------------------------------------------------
// Web HCP bridge bootstrap (seed meteor-desktop-e490).
//
// In a Meteor 3.x web.browser desktop build there is no cordova-plugin-meteor-
// webapp consumer, so nothing drives this WebAppLocalServer bridge:
//   - the stock autoupdate client reloads in place (Reload._reload) instead of
//     calling checkForUpdates(), so the desktop side never DOWNLOADS a bundle;
//   - nothing registers onNewVersionReady, so a staged bundle is never APPLIED.
// (Meteor.isDesktop and startupDidComplete are already handled by the build's
// isDesktopInjector, so the startup-timer revert is not a concern here.)
//
// This bootstrap supplies only those two missing hooks. It is DOWNLOAD-only +
// APPLY-via-the-existing-gate: the swap rides Meteor's standard Reload pipeline
// (the app's Reload._onMigrate handler defers it on desktop and applies it at a
// safe route), so we never add a second reload gate or bypass holy-ops gating.
(() => {
    // How often to re-ask the desktop side for a newer bundle once running.
    const CHECK_INTERVAL_MS = 10 * 60 * 1000;

    const getReload = () => (window.Package
        && window.Package.reload
        && window.Package.reload.Reload) || null;

    const requestCheck = () => {
        try {
            WebAppLocalServer.checkForUpdates();
        } catch (e) {
            console.warn('[meteor-desktop] HCP checkForUpdates failed', e);
        }
    };

    // A loopback ROOT_URL means a dev `meteor run` or an e2e harness: the served bundle version
    // can never equal the one baked into the asar, so every automatic check downloads a bundle
    // that the shell's own verifyRuntimeConfig then refuses ("ROOT_URL in downloaded asset bundle
    // would change current ROOT_URL to localhost") — the served host and the baked ddp_url are
    // different spellings of loopback. Futile by construction, so do not start the timer.
    //
    // Prod is untouched: a release passes an explicit ddp_url, which lib/meteorApp.js writes into
    // runtimeConfig.ROOT_URL, so this reads the real host and returns false.
    const isLoopbackRootUrl = () => {
        try {
            // Cast: Meteor injects __meteor_runtime_config__ inline in index.html, so it is not
            // on the DOM lib's Window type.
            const rootUrl = (/** @type {any} */ (window).__meteor_runtime_config__ || {}).ROOT_URL || '';
            const host = new URL(rootUrl).hostname;
            // WHATWG URL always serializes an IPv6 hostname bracketed, so the bare '::1' form is
            // unreachable here (and is not even a parseable URL) — no branch for it.
            return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
        } catch (e) {
            console.warn('[meteor-desktop] HCP loopback check failed, assuming non-loopback', e);
            return false;
        }
    };

    const start = () => {
        // CONFIRM STARTUP (seed meteor-desktop-hcp-brick). We are inside
        // Meteor.startup, so this bundle's JS executed successfully → this version
        // booted OK. Signal that to the desktop shell so it cancels the startup-
        // timer revert (autoupdate.js startStartupTimer/revertToLastKnownGoodVersion)
        // and records the version as last-known-good.
        //
        // This MUST be fired here for web HCP: the stock cordova-plugin-meteor-webapp
        // call that normally fires startupDidComplete exists ONLY in meteor-desktop's
        // own embedded build (where the isDesktopInjector rewrites its isCordova gate
        // to isDesktop) — it is ABSENT from the plain web.browser bundle the server
        // serves over HCP. Without this, a downloaded version never signals completion
        // and the shell loops reset → 5-min timeout → revert forever (the stuck-splash
        // brick). A genuinely broken bundle never reaches Meteor.startup, so the
        // bad-version revert safety is preserved. On the embedded build the injected
        // cordova call also fires it; startupDidComplete is idempotent so the double
        // fire is harmless.
        try {
            WebAppLocalServer.startupDidComplete();
        } catch (e) {
            console.warn('[meteor-desktop] startupDidComplete signal failed', e);
        }

        // Register an error sink so the bridge's 'error' handler (which calls
        // WebAppLocalServer.onErrorCallback) never invokes a null callback when
        // a check fails (e.g. the HCP server is unreachable).
        WebAppLocalServer.onError((cause) => {
            console.warn('[meteor-desktop] HCP error:', cause);
        });

        // APPLY hook: when the desktop side has a verified, staged bundle, route
        // it through Meteor's standard Reload pipeline rather than forcing a raw
        // reload — so the app's existing onMigrate gate decides WHEN to swap.
        WebAppLocalServer.onNewVersionReady(() => {
            const Reload = getReload();
            if (Reload && typeof Reload._reload === 'function') {
                Reload._reload();
            }
        });

        // DOWNLOAD trigger: check now and on a periodic poll. The desktop side
        // no-ops when the served manifest version equals the current bundle.
        //
        // GATE ONLY THESE TWO LINES — never return early from the top of start(). The three
        // registrations above are required in every environment: without startupDidComplete() the
        // shell never records a last-known-good version and loops reset -> 5-min timeout -> revert
        // forever (the stuck-splash brick, seed meteor-desktop-hcp-brick).
        //
        // checkForUpdates() itself stays callable, which is deliberate: it is the public API, and
        // e2e/tests/electron-hcp-download-progress.spec.js drives it directly to exercise the
        // download/overlay/dismissal path on purpose. Gating the timer removes the futile
        // automatic churn without removing the only harness that covers that path (seed e2e-5c54).
        if (isLoopbackRootUrl()) {
            console.log('[meteor-desktop] HCP automatic update checks disabled: ROOT_URL is loopback '
                + '(dev/e2e), where the served bundle never matches the packaged one. '
                + 'WebAppLocalServer.checkForUpdates() still works if called directly.');
            return;
        }
        requestCheck();
        setInterval(requestCheck, CHECK_INTERVAL_MS);
    };

    // desktop-hcp.js is injected BEFORE meteor.js, so defer until Meteor is up.
    const whenReady = () => {
        if (typeof Meteor !== 'undefined' && typeof Meteor.startup === 'function') {
            Meteor.startup(start);
            return;
        }
        setTimeout(whenReady, 50);
    };
    whenReady();
})();
