/**
 This is a modified JS port of hot code push android client from here:
 https://github.com/meteor/cordova-plugin-meteor-webapp

 The MIT License (MIT)

 Copyright (c) 2015 Meteor Development Group

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in all
 copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.

 This file is based on:
 /cordova-plugin-meteor-webapp/blob/master/src/android/WebAppLocalServer.java

 desktopHCP was removed in v6.0.0. Fork v5.1.7 if you need .desktop hot code push.
 Meteor's standard web.browser HCP continues to work via this module.
 */

import path from 'path';
import fs from 'fs-plus';
import { createRequire } from 'module';
import url from 'url';

import AssetBundle from './autoupdate/assetBundle.js';
import AssetBundleManager from './autoupdate/assetBundleManager.js';
import utils from './autoupdate/utils.js';
import DesktopPathResolver from '../desktopPathResolver.js';

const { join } = path;
const { compareCoreVersions } = utils;
const require = createRequire(import.meta.url);

let originalFs = fs;
try {
    originalFs = require('original-fs');
} catch {
    // Falls back to fs-plus outside Electron.
}

/**
 * Represents the hot code push client.
 * Unlike the Cordova implementation this does not have a builtin HTTP server.
 *
 * @constructor
 */
export default class HCPClient {
    constructor({
        log, appSettings, eventsBus, settings, Module
    }) {
        // Get the automatically predefined logger instance.
        this.log = log;

        // Register this as a Meteor Desktop module.
        this.module = new Module('autoupdate');

        this.settings = settings;
        this.appSettings = appSettings;

        this.startupTimer = null;
        this.window = null;
        this.warnedAboutMissingNativeVersion = false;

        this.eventsBus = eventsBus;

        // We want this to be initialized before loading the desktop part.
        this.eventsBus.on('beforeDesktopJsLoad', this.init.bind(this));

        // We will need a reference to the BrowserWindow object once it will be available.
        this.eventsBus.on('windowCreated', (window) => {
            this.window = window;
            // Drop the reference when the window goes away, mirroring skeleton/app.js. Without
            // this, a startup-timer expiry that lands after the window was destroyed calls
            // reload() on a dead BrowserWindow and throws "Object has been destroyed".
            window.on('closed', () => {
                this.window = null;
            });
            // Start the startup timer.
            this.startStartupTimer();
        });

        // Lets register for some ICP events. You can treat this as public API.
        this.module.on('checkForUpdates', this.checkForUpdates.bind(this));
        this.module.on('startupDidComplete', this.startupDidComplete.bind(this));

        this.resetConfig();

        this.configFile = join(this.settings.dataPath, 'autoupdate.json');
        this.versionsDir = join(this.settings.bundleStorePath, 'versions');
    }

    /**
     * Resets or sets an empty config object.
     *
     * @private
     */
    resetConfig() {
        this.config = {
            appId: null,
            rootUrlString: null,
            blacklistedVersions: [],
            lastDownloadedVersion: null,
            lastSeenInitialSignature: null
        };
    }

    /**
     * Performs autoupdate initialization.
     *
     * @private
     */
    init() {
        this.log.verbose('initializing autoupdate module');
        try {
            fs.accessSync(this.configFile, fs.F_OK);
        } catch {
            this.saveConfig();
            this.log.info('created empty autoupdate.json');
        }

        this.readConfig();
        this.initializeAssetBundles();

        this.config.appId = this.currentAssetBundle.getAppId();
        this.config.rootUrlString = this.currentAssetBundle.getRootUrlString();

        this.saveConfig();
    }

    /**
     * Looks for available assets bundles. Chooses which version to use.
     *
     * @private
     */
    initializeAssetBundles() {
        this.log.verbose('trying to read initial bundle version');
        const initialAssetBundle = new AssetBundle(
            this.log,
            this.settings.initialBundlePath
        );
        const initialSignature = DesktopPathResolver.readAssetBundleSignature(
            this.settings.initialBundlePath
        );
        const initialVersionChanged = initialAssetBundle.getVersion() !== this.config.lastSeenInitialVersion;
        const initialSignatureChanged = !!(
            this.config.lastSeenInitialSignature
            && initialSignature
            && this.config.lastSeenInitialSignature !== initialSignature
        );

        // If the last seen initial version is different from the currently bundled
        // version, we delete the versions directory and unset lastDownloadedVersion
        // and blacklistedVersions.
        if (initialVersionChanged || initialSignatureChanged) {
            this.log.info(
                'detected changed embedded bootstrap state, removing versions directory if it exists'
            );
            if (fs.existsSync(this.versionsDir)) {
                // Using rimraf specifically instead of shelljs.rm because despite using
                // process.noAsar shelljs tried to remove files inside asar instead of just
                // deleting the archive. `del` also could not delete asar archive. Rimraf is ok
                // because it accepts custom fs object.
                originalFs.rmSync(this.versionsDir, { recursive: true, force: true });
                if (fs.existsSync(this.versionsDir)) {
                    this.log.warn('could not remove versions directory');
                }
            }
            this.resetConfig();
        }

        // We keep track of the last seen initial version (see above).
        this.config.lastSeenInitialVersion = initialAssetBundle.getVersion();
        this.config.lastSeenInitialSignature = initialSignature || null;

        // If the versions directory does not exist, we create it.
        if (!fs.existsSync(this.versionsDir)) {
            this.log.info('created versions dir');
            // TODO: what if this fails? We need to report this to the main app.
            fs.mkdirSync(this.versionsDir);
        }

        this.assetBundleManager = new AssetBundleManager(
            this.log,
            this.config,
            initialAssetBundle,
            this.versionsDir,
            this.appSettings
        );

        this.assetBundleManager.setCallback(this);

        this.currentAssetBundle = null;

        const { lastDownloadedVersion } = this.config;
        if (lastDownloadedVersion) {
            if (~this.config.blacklistedVersions.indexOf(lastDownloadedVersion)) {
                this.useLastKnownGoodVersion();
            } else if (lastDownloadedVersion !== initialAssetBundle.getVersion()) {
                this.currentAssetBundle = this.assetBundleManager
                    .downloadedAssetBundleWithVersion(lastDownloadedVersion);
                this.log.verbose(
                    `will use last downloaded version (${lastDownloadedVersion})`
                );

                if (!this.currentAssetBundle) {
                    this.log.warn('seems that last downloaded version does not exists... ');
                    this.useLastKnownGoodVersion();
                } else if (lastDownloadedVersion !== this.config.lastKnownGoodVersion) {
                    this.startStartupTimer();
                }
            } else {
                this.currentAssetBundle = initialAssetBundle;
                this.log.verbose(
                    'will use last downloaded version which is apparently also the initial asset bundle '
                    + `(${lastDownloadedVersion})`
                );
            }
        } else {
            this.log.verbose('using initial asset bundle');
            this.currentAssetBundle = initialAssetBundle;
        }

        this.pendingAssetBundle = null;
    }

    /**
     * Reverts to either last known good version or the initial version if there is none available.
     * @private
     */
    useLastKnownGoodVersion() {
        const { lastKnownGoodVersion } = this.config;
        this.log.debug(`last known good version is ${this.config.lastKnownGoodVersion}`);
        if (lastKnownGoodVersion
            && lastKnownGoodVersion !== this.assetBundleManager.initialAssetBundle.getVersion()) {
            const assetBundle = this.assetBundleManager
                .downloadedAssetBundleWithVersion(lastKnownGoodVersion);
            if (assetBundle) {
                this.log.info(`will use last known good version: ${assetBundle.getVersion()}`);
                this.currentAssetBundle = assetBundle;
                return;
            }

            this.log.warn('configured last known good version is missing on disk, falling back '
                + 'to the initial asset bundle');
        } else {
            this.log.verbose('using initial asset bundle because last know good version'
                + 'does not exist');
        }

        this.currentAssetBundle = this.assetBundleManager.initialAssetBundle;
    }

    /**
     * Start the checking for update procedure.
     * @private
     */
    checkForUpdates() {
        const rootUrl = this.settings.customHCPUrl
            ? this.settings.customHCPUrl : this.currentAssetBundle.getRootUrlString();

        this.log.verbose(`checking for updates on ${rootUrl}`);
        if (!rootUrl) {
            this.log.error('no rootUrl found in the current asset bundle');
            this.module.send(
                'error',
                'checkForUpdates requires a rootURL to be configured'
            );
            return;
        }

        this.assetBundleManager.checkForUpdates(url.resolve(rootUrl, '/'));
    }

    /**
     * Returns version of the currently pending asset bundle.
     * @returns {null|string}
     */
    getPendingVersion() {
        if (this.pendingAssetBundle !== null) {
            return this.pendingAssetBundle.getVersion();
        }
        return null;
    }

    /**
     * Returns the currently used asset bundle.
     *
     * @returns {null|AssetBundle}
     */
    getCurrentAssetBundle() {
        return this.currentAssetBundle;
    }

    /**
     * Returns the current assets bundle's directory.
     * @returns {string}
     */
    getDirectory() {
        return this.currentAssetBundle.getDirectoryUri();
    }

    /**
     * Returns the parent asset bundle's directory.
     * @returns {string|null}
     */
    getParentDirectory() {
        return this.currentAssetBundle.getParentAssetBundle()
            ? this.currentAssetBundle.getParentAssetBundle().getDirectoryUri() : null;
    }

    /**
     * Starts the startup timer which is a fallback mechanism in case we received a faulty version.
     * @private
     */
    startStartupTimer() {
        this.removeStartupTimer();

        this.startupTimerStartTimestamp = Date.now();
        this.startupTimer = setTimeout(() => {
            this.removeStartupTimer();
            this.revertToLastKnownGoodVersion();
        }, this.settings.webAppStartupTimeout);

        this.log.verbose('started startup timer');
        this.log.debug(`timer set to ${this.settings.webAppStartupTimeout}`);
    }

    /**
     * Reverts to last know good version in case we did not receive an event saying that the app
     * has started successfully.
     * @private
     */
    revertToLastKnownGoodVersion() {
        // Blacklist the current version, so we don't update to it again right away.
        this.log.warn('startup timer expired, reverting to another version');

        // If this is the initial version, we will not get anything from blacklisting it.
        if (this.currentAssetBundle.getVersion()
            !== this.assetBundleManager.initialAssetBundle.getVersion()
            && !~this.config.blacklistedVersions.indexOf(this.currentAssetBundle.getVersion())
        ) {
            this.log.debug(`blacklisted version ${this.currentAssetBundle.getVersion()}`);
            this.config.blacklistedVersions.push(this.currentAssetBundle.getVersion());
            this.saveConfig();
        }

        // If there is a last known good version and we can load the bundle, revert to it.
        const { lastKnownGoodVersion } = this.config;
        this.log.debug(`last known good version is ${this.config.lastKnownGoodVersion}`);
        if (lastKnownGoodVersion
            && lastKnownGoodVersion !== this.assetBundleManager.initialAssetBundle.getVersion()) {
            const assetBundle = this.assetBundleManager
                .downloadedAssetBundleWithVersion(lastKnownGoodVersion);
            if (assetBundle && assetBundle.getVersion() !== this.currentAssetBundle.getVersion()) {
                this.log.info(`reverting to last known good version: ${assetBundle.getVersion()}`);
                this.pendingAssetBundle = assetBundle;
            }
        } else if (this.currentAssetBundle.getVersion()
            !== this.assetBundleManager.initialAssetBundle.getVersion()) {
            // Else, revert to the initial asset bundle, unless that is what we are currently
            // serving.
            this.log.info('reverting to initial bundle');
            this.pendingAssetBundle = this.assetBundleManager.initialAssetBundle;
        }

        // Only reload if we have a pending asset bundle to reload AND a window to reload it in -
        // the timer can expire during teardown, when both the emit and the reload are pointless.
        if (this.pendingAssetBundle && this.window) {
            this.eventsBus.emit('revertVersionReady');
            this.log.warn(`will try to revert to ${this.pendingAssetBundle.getVersion()}`);
            this.window.reload();
        }
    }

    /**
     * Stops the startup timer.
     * @private
     */
    removeStartupTimer() {
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }
    }

    /**
     * Fired from the Meteor app. Tells us that this version seems to be fine.
     *
     * @param {function} onVersionsCleanedUp - callback to be called after versions dir cleanup
     *
     * @private
     */
    startupDidComplete(onVersionsCleanedUp = Function.prototype) {
        this.log.verbose('startup did complete, stopping startup timer (startup took '
            + `${Date.now() - this.startupTimerStartTimestamp}ms)`);

        // Remove this version from blacklisted.
        if (~this.config.blacklistedVersions.indexOf(this.currentAssetBundle.getVersion())) {
            this.config.blacklistedVersions.splice(
                this.config.blacklistedVersions.indexOf(this.currentAssetBundle.getVersion()),
                1
            );
            this.saveConfig();
        }

        this.removeStartupTimer();

        // If startup completed successfully, we consider a good version.
        this.config.lastKnownGoodVersion = this.currentAssetBundle.getVersion();
        this.saveConfig();

        this.eventsBus.emit('startupDidComplete');

        setImmediate(() => {
            this.assetBundleManager
                .removeAllDownloadedAssetBundlesExceptForVersion(
                    this.currentAssetBundle
                )
                .then((status) => {
                    // Some of the clearing operations may have failed but we can live with it.
                    if (typeof onVersionsCleanedUp === 'function') {
                        onVersionsCleanedUp(status);
                    }
                    this.module.send('onVersionsCleanedUp', status);
                });
        });
    }

    /**
     * This is fired when a new version is ready and we need to reset (reload) the BrowserWindow.
     */
    onReset() {
        // If there is a pending asset bundle, we make it the current
        if (this.pendingAssetBundle !== null) {
            this.currentAssetBundle = this.pendingAssetBundle;
            this.pendingAssetBundle = null;
        }

        this.log.info(`serving asset bundle with version: ${this.currentAssetBundle.getVersion()}`);

        this.config.appId = this.currentAssetBundle.getAppId();
        this.config.rootUrlString = this.currentAssetBundle.getRootUrlString();

        this.saveConfig();

        // Don't start startup timer when running a test.
        if (!this.settings.test) {
            this.startStartupTimer();
        }
    }

    /**
     * Save the current config.
     * @private
     */
    saveConfig() {
        fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, '\t'));
    }

    /**
     * Reads config json file.
     * @private
     */
    readConfig() {
        try {
            this.config = JSON.parse(fs.readFileSync(this.configFile, 'utf-8'));
        } catch {
            this.log.error('could not read the config.json');
            this.resetConfig();
            this.resetConfig();
            this.saveConfig();
        }
    }

    /**
     * Error callback fired by assetBundleManager.
     * @param cause
     */
    onError(cause) {
        this.notifyError(cause);
    }

    /**
     * Download-started callback fired by assetBundleManager, once a bundle download is actually
     * committed to (not merely considered).
     *
     * Until this existed the only renderer-facing HCP signal was onNewVersionReady, which fires
     * when the whole bundle has already landed — so a Meteor app could not tell "no update" from
     * "downloading 40MB over a slow link", and had nothing to show the user or block on.
     *
     * @param {number} bytesTotal - Total bytes to download, summed from the manifest entries.
     */
    onDownloadStarted(bytesTotal) {
        this.log.verbose(`started downloading asset bundle (${bytesTotal} bytes)`);
        this.eventsBus.emit('downloadStarted', bytesTotal);
        this.module.send('onDownloadStarted', bytesTotal);
    }

    /**
     * Progress callback fired by assetBundleManager, once per verified and written asset.
     *
     * @param {number} bytesTransferred - Bytes written so far.
     * @param {number} bytesTotal       - Total bytes to download.
     */
    onDownloadProgress(bytesTransferred, bytesTotal) {
        this.eventsBus.emit('downloadProgress', bytesTransferred, bytesTotal);
        this.module.send('onDownloadProgress', bytesTransferred, bytesTotal);
    }

    /**
     * Fires error callback from the Meteor app side.
     *
     * @param {string} cause - error message
     * @private
     */
    notifyError(cause) {
        this.log.error(`download failure: ${cause}`);
        this.module.send(
            'error',
            `[autoupdate] Download failure: ${cause}`
        );
    }

    /**
     * Fires console.warn on the Meteor app side.
     *
     * @param {string} cause - warn message
     * @private
     */
    notifyWarning(cause) {
        this.module.send(
            'warn',
            `[autoupdate] Warning: ${cause}`
        );
    }

    /**
     * Makes downloaded asset pending. Fired by assetBundleManager.
     * @param assetBundle
     */
    onFinishedDownloadingAssetBundle(assetBundle) {
        this.log.verbose(
            `setting last downloaded and pending version as ${assetBundle.getVersion()}`
        );
        this.config.lastDownloadedVersion = assetBundle.getVersion();
        this.saveConfig();
        this.pendingAssetBundle = assetBundle;
        this.notifyNewVersionReady(assetBundle.getVersion());
    }

    /**
     * Notify meteor that a new version is ready.
     * @param {string} version - version string
     *
     * @private
     */
    notifyNewVersionReady(version) {
        this.eventsBus.emit('newVersionReady', version);
        this.module.send('onNewVersionReady', version);
    }

    /**
     * Tells the app that a JS bundle was refused because the installed native shell is too old,
     * so the only way forward is a full signed-binary (electron-updater) update.
     *
     * NOTE FOR CONSUMERS: nothing in meteor-desktop acts on this. The app has to subscribe and
     * drive its own native updater — until it does, the gate's whole effect is that HCP stops for
     * that bundle. It is re-emitted on every check (the renderer polls every 10 minutes), exactly
     * like the existing blacklist notification, so debounce it before showing UI.
     *
     * @param {String} version  - Version of the refused bundle.
     * @param {String} required - Minimum native version the bundle declared.
     * @param {String} installed - Native version actually installed.
     *
     * @private
     */
    notifyNativeUpdateRequired(version, required, installed) {
        const payload = { version, required, installed };
        this.eventsBus.emit('nativeUpdateRequired', payload);
        this.module.send('onNativeUpdateRequired', payload);
    }

    /**
     * Native-vs-JS compatibility gate (seed meteor-desktop-0a0e).
     *
     * Native and JS update on independent channels — native only through electron-updater
     * (desktopHCP was removed in v6.0.0), JS bundles over the air through HCP — so a bundle built
     * against desktop APIs a user's installed shell does not have can otherwise be served to it.
     *
     * The comparison is ORDERED (`installed >= required`), not an equality test, and that is
     * deliberate. It makes the safe direction safe: an OLD bundle on a NEW native is accepted,
     * which is what happens to a pending bundle right after a native update, and it also means
     * forgetting to publish a bump degrades to "gate too permissive" rather than "HCP dead for the
     * whole fleet". Seed 0a0e's literal wording was an EQUALITY test on the build-time
     * `compatibilityVersion` md5; that value is unordered, so it cannot tell those two directions
     * apart. See CHANGELOG for the deviation.
     *
     * Fail-open on absence: a bundle that declares nothing, or a native with no version in its
     * settings, is accepted.
     *
     * @param {AssetManifest} manifest - Manifest of the offered bundle.
     *
     * @returns {Boolean} - True when the installed native can run this bundle.
     * @private
     */
    isNativeCompatibleWithManifest(manifest) {
        const required = manifest.minDesktopVersion;
        if (!required) {
            return true;
        }

        const installed = this.appSettings && this.appSettings.version;
        if (!installed) {
            // Once, not on every poll: the renderer re-checks every 10 minutes, and a build with no
            // version paired with a floor-declaring server would otherwise warn forever.
            if (!this.warnedAboutMissingNativeVersion) {
                this.warnedAboutMissingNativeVersion = true;
                this.log.warn(
                    `bundle ${manifest.version} requires native version ${required} but this build `
                    + 'has no version in its desktop settings — accepting it'
                );
            }
            return true;
        }

        if (compareCoreVersions(installed, required) >= 0) {
            return true;
        }

        this.log.warn(
            `skipping bundle ${manifest.version}: it requires native version ${required}, `
            + `installed is ${installed} — a native update is needed`
        );
        this.notifyNativeUpdateRequired(manifest.version, required, installed);
        return false;
    }

    /**
     * Method that decides whether we are interested in the new bundle that we were notified about.
     * Called by assetBundleManager.
     * @param {AssetManifest} manifest - manifest of the new bundle
     *
     * @returns {boolean}
     */
    shouldDownloadBundleForManifest(manifest) {
        const { version } = manifest;

        // Compat first, ahead of the current/pending/blacklist skips: those answer "do we already
        // have it", this answers "may we run it at all", and the app is entitled to hear that a
        // native update is due even for a version it happens to be holding.
        if (!this.isNativeCompatibleWithManifest(manifest)) {
            return false;
        }

        // No need to redownload the current version.
        if (this.currentAssetBundle.getVersion() === version) {
            this.log.info(`skipping downloading current version: ${version}`);
            return false;
        }

        // No need to redownload the pending version.
        if (this.pendingAssetBundle
            && this.pendingAssetBundle.getVersion() === version) {
            this.log.info(`skipping downloading pending version: ${version}`);
            return false;
        }

        // Don't download blacklisted versions.
        if (~this.config.blacklistedVersions.indexOf(version)) {
            this.log.warn(`skipping downloading blacklisted version: ${version}`);
            this.notifyError(`skipping downloading blacklisted version: ${version}`);
            return false;
        }

        return true;
    }
}
