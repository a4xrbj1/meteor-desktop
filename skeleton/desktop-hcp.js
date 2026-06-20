/**
 * Historical name — this file defines WebAppLocalServer for Meteor's standard web HCP.
 * Based on: https://github.com/meteor/cordova-plugin-meteor-webapp/blob/master/www/webapp_local_server.js
 */

// eslint-disable-next-line no-global-assign
WebAppLocalServer = {
    onNewVersionReadyCallback: null,
    onErrorCallback: null,
    onVersionsCleanedUpCallback: null,

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

    onError(callback) {
        this.onErrorCallback = callback;
    }
};

Desktop.on('autoupdate', 'error', (event, args) => {
    WebAppLocalServer.onErrorCallback(args);
});

Desktop.on('autoupdate', 'warn', (event, args) => {
    console.warn(args);
});

Desktop.on('autoupdate', 'onVersionsCleanedUp', () => {
    if (WebAppLocalServer.onVersionsCleanedUpCallback) {
        WebAppLocalServer.onVersionsCleanedUpCallback();
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
