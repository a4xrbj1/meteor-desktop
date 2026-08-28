import path from 'path';
import fs from 'fs-plus';
import url from 'url';
import { createRequire } from 'module';

import AssetBundle from './assetBundle.js';
import AssetBundleDownloader from './assetBundleDownloader.js';
import AssetManifest from './assetManifest.js';
import utils from './utils.js';

const require = createRequire(import.meta.url);
let originalFs = fs;
try {
    originalFs = require('original-fs');
} catch {
    // Falls back to fs-plus outside Electron.
}

const {
    rimrafWithRetries, modernUserAgent, DEFAULT_HCP_REQUEST_TIMEOUT, DEFAULT_HCP_STALL_TIMEOUT
} = utils;

/**
 * True when the manifest's own subresource-integrity digest vouches for the cached bytes.
 *
 * `sri` (base64 sha512) is the one manifest field that is a digest of the served bytes — the
 * legacy `hash` is not, which `AssetBundleDownloader.verifyResponse` says in as many words — and it
 * is the field `verifyResponse` checked before those bytes were ever written to disk. So an sri
 * present on both sides and equal is proof, without re-hashing anything. Re-hashing would in fact
 * be wrong as well as slow: a `js` asset is rewritten on disk by the isDesktop injector after
 * verification, so its file no longer matches any digest in any manifest.
 *
 * @param {Asset} asset       - Asset the new manifest asks for.
 * @param {Asset} cachedAsset - Candidate already on disk.
 *
 * @returns {Boolean} - True when both carry the same sri.
 */
const sriVouchesForCachedAsset = function (asset, cachedAsset) {
    return !!asset.sri && cachedAsset.sri === asset.sri;
};

/**
 * True when the two manifests agree on a real `hash` for this asset.
 *
 * This is the identity the incremental download has always run on: `hash` is Meteor's per-asset
 * version marker (the sha1 in the asset's url), so two manifests naming the same one mean the same
 * asset version. What it deliberately excludes is `cachedAssetForUrlPath`'s other branch,
 * `asset.cacheable && hash === null`, which matches on the url path ALONE and therefore asserts
 * nothing whatsoever about the bytes — that is the route by which a stale directory can hand back
 * a different build's asset under the path this manifest wants (seed meteor-desktop-932b).
 *
 * @param {Asset} asset       - Asset the new manifest asks for.
 * @param {Asset} cachedAsset - Candidate already on disk.
 *
 * @returns {Boolean} - True when both name the same non-null hash.
 */
const hashIdentifiesCachedAsset = function (asset, cachedAsset) {
    return asset.hash !== null && cachedAsset.hash === asset.hash;
};

/**
 * Whether a cached asset's bytes may stand in for one this manifest asks for.
 *
 * A reused asset is copied straight into the new bundle directory, so it never passes through
 * `verifyResponse` — whatever is on disk is what the app will run. That is why the match which
 * found it is not by itself a licence to use it.
 *
 * The two cache sources do NOT get the same test, because the same comparison does not mean the
 * same thing in both:
 *
 *  - A COMPLETE bundle in `versions/` carries its OWN version's manifest, so agreeing on `hash` is
 *    a genuine claim by two independently written manifests about one asset version, and those
 *    bytes already passed `verifyResponse` when that bundle was downloaded. Hash or sri will do.
 *  - The PARTIAL download directory keeps the manifest of the PREVIOUS ATTEMPT.
 *    `moveExistingDownloadDirectoryIfNeeded` renames the half-finished `Downloading` dir wholesale,
 *    program.json and all, and it runs BEFORE the new manifest is written into the fresh directory.
 *    Which manifest that leaves behind depends on why the attempt was abandoned, and the caller
 *    cannot tell the two apart at this point:
 *      * a RETRY of the same version leaves the identical manifest, so comparing hashes compares
 *        that manifest with ITSELF and cannot fail, whatever bytes are lying in the directory;
 *      * a SUPERSEDE leaves an older version's manifest, where a hash comparison would be genuine.
 *    Since only the first is distinguishable by its consequences and it is the dangerous one, sri —
 *    which `verifyResponse` actually checked against the bytes — is the only thing accepted here.
 *    This is the arch-mismatch resurrection route seed frontend-7c13 fixed: legacy bytes filed under
 *    a modern manifest, reused from cache with nothing in the path to catch them.
 *
 * `existsSync`, not `accessSync`: accessSync returns undefined on success and throws on a missing
 * file, so the guard this replaces could never be true and the partial branch always fell through
 * to null — every retry re-downloaded the whole bundle. The comment above it said existsSync.
 *
 * @param {Asset}   asset       - Asset the new manifest asks for.
 * @param {Asset}   cachedAsset - Candidate already on disk.
 * @param {Boolean} sriOnly     - True for the partial directory, where hashes are self-referential.
 *
 * @returns {Boolean} - True when the cached bytes may be reused.
 */
const canReuseCachedAsset = function (asset, cachedAsset, sriOnly) {
    // When both manifests carry an sri it is decisive in BOTH directions. Agreeing proves the
    // bytes. Disagreeing disproves them however well the hashes match — that combination is two
    // manifests contradicting each other about one asset version, and the content digest is the
    // one of the two that actually describes content.
    if (asset.sri && cachedAsset.sri) {
        return sriVouchesForCachedAsset(asset, cachedAsset)
            && fs.existsSync(cachedAsset.getFile());
    }
    if (sriOnly) {
        return false;
    }
    return hashIdentifiesCachedAsset(asset, cachedAsset) && fs.existsSync(cachedAsset.getFile());
};

class AssetBundleManager {
    /**
     * @param {object}      log                - Logger instance from loggerManager.
     * @param {object}      configuration      - Configuration object.
     * @param {AssetBundle} initialAssetBundle - Parent asset bundle.
     * @param {string}      versionsDirectory  - Path to versions dir.
     * @param {Object}      appSettings        - The app's built .desktop/settings.json.
     * @constructor
     */
    constructor(
        log, configuration, initialAssetBundle, versionsDirectory, appSettings
    ) {
        this.log = log.getLoggerFor('AssetBundleManager');

        this.appSettings = appSettings;
        this.configuration = configuration;
        this.initialAssetBundle = initialAssetBundle;

        this.versionsDirectory = versionsDirectory;

        this.downloadDirectory = path.join(versionsDirectory, 'Downloading');
        this.partialDownloadDirectory = path.join(versionsDirectory, 'PartialDownload');

        this.downloadedAssetBundlesByVersion = {};
        this.partiallyDownloadedAssetBundle = null;

        this.callback = null;
        this.assetBundleDownloader = null;

        this.httpClient = globalThis.fetch;

        this.loadDownloadedAssetBundles();
    }

    /**
     * Callback setter.
     *
     * @param {Object} callback
     */
    setCallback(callback) {
        this.callback = callback;
    }

    /**
     * Returns a bundle searched by version.
     * @param {string} version - Version to get.
     * @returns {AssetBundle|null}
     */
    downloadedAssetBundleWithVersion(version) {
        if (version in this.downloadedAssetBundlesByVersion) {
            return this.downloadedAssetBundlesByVersion[version];
        }
        return null;
    }

    /**
     * Starts checking for available update.
     *
     * @param {string} baseUrl - Url of meteor server.
     */
    checkForUpdates(baseUrl) {
        let manifest;
        // Meteor 3.x web.browser manifest endpoint (webapp package: /__<arch>/manifest.json).
        const manifestUrl = url.resolve(baseUrl, '__browser/manifest.json');

        this.log.info(`trying to query ${manifestUrl}`);

        // A fetch with no timeout is how HCP wedges silently: a server that accepts the connection
        // and never answers leaves the check hanging forever, emitting nothing (seed
        // meteor-desktop-5aa1). The abort surfaces in the .catch below as an ordinary didFail, so
        // the renderer hears about it and the next 10-minute poll retries — nothing is blacklisted
        // on an error path (the only writer of blacklistedVersions is the startup-timer revert).
        this.httpClient(manifestUrl, {
            headers: { Connection: 'close', 'User-Agent': modernUserAgent },
            signal: AbortSignal.timeout(this.resolveTimeout('hcpRequestTimeout', DEFAULT_HCP_REQUEST_TIMEOUT))
        })
            .then((response) => Promise.all([response, response.text()]))
            .then(([response, body]) => {
                if (response.status !== 200) {
                    this.didFail(
                        `non-success status code ${response.status} for asset manifest at ${manifestUrl}`
                    );
                    return;
                }

                try {
                    manifest = new AssetManifest(this.log, body);
                } catch (e) {
                    this.didFail(e.message);
                    return;
                }
                const { version } = manifest;
                this.log.debug(`downloaded asset manifest for version: ${version}`);

                if (
                    this.assetBundleDownloader !== null
                    && this.assetBundleDownloader.getAssetBundle().getVersion() === version
                ) {
                    this.log.info(`already downloading asset bundle version: ${version}`);
                    // Dead until seed meteor-desktop-912a assigned the field below. It returns
                    // without downloading, so without an event of its own it would be the one path
                    // that starts a check and yields no outcome — the exact silence Stage 4 (seed
                    // meteor-desktop-5aa1) removed everywhere else.
                    if (this.callback !== null && this.callback.onDownloadAlreadyInProgress) {
                        this.callback.onDownloadAlreadyInProgress(version);
                    }
                    return;
                }

                // Give the callback a chance to decide whether the version should be downloaded.
                if (
                    this.callback !== null
                    && !this.callback.shouldDownloadBundleForManifest(manifest)
                ) {
                    return;
                }

                // Cancel download in progress if there is one.
                if (this.assetBundleDownloader !== null) {
                    this.assetBundleDownloader.cancel();
                }
                this.assetBundleDownloader = null;

                // There is no need to re-download the initial version.
                if (this.initialAssetBundle.getVersion() === version) {
                    this.log.debug('No redownload of initial version.');
                    this.didFinishDownloadingAssetBundle(this.initialAssetBundle);
                    return;
                }

                // If there is a previously downloaded asset bundle with the requested
                // version, use that.
                if (version in this.downloadedAssetBundlesByVersion) {
                    const downloadedAssetBundle = this.downloadedAssetBundlesByVersion[version];
                    if (downloadedAssetBundle !== null) {
                        this.didFinishDownloadingAssetBundle(downloadedAssetBundle);
                        return;
                    }
                }

                // Else, get ready to download the new asset bundle
                this.moveExistingDownloadDirectoryIfNeeded();

                // Create download directory
                if (!this.makeDownloadDirectory()) {
                    this.didFail('could not create download directory');
                    return;
                }

                // Copy downloaded asset manifest to file.
                try {
                    fs.writeFileSync(path.join(this.downloadDirectory, 'program.json'), body);
                } catch (e) {
                    this.didFail(e.message);
                    return;
                }
                this.log.debug('manifest copied to new Download dir');

                let assetBundle = null;
                try {
                    assetBundle = new AssetBundle(
                        this.log,
                        this.downloadDirectory,
                        manifest,
                        this.initialAssetBundle
                    );
                } catch (e) {
                    this.didFail(e.message);
                    return;
                }

                this.downloadAssetBundle(assetBundle, baseUrl);
            })
            // The fetch chain had no rejection handler: a network error (server
            // unreachable / offline) surfaced as an UnhandledPromiseRejection.
            // Now that the web-HCP bootstrap polls checkForUpdates() routinely
            // (seed meteor-desktop-e490), route those failures through didFail.
            .catch((e) => {
                this.didFail(`error querying asset manifest at ${manifestUrl}: ${e.message}`);
            });
    }

    /**
     * Removes unnecessary versions.
     *
     * @param {AssetBundle} assetBundleToKeep
     * @returns {Promise}
     */
    removeAllDownloadedAssetBundlesExceptForVersion(assetBundleToKeep) {
        const promises = [];
        Object.keys(this.downloadedAssetBundlesByVersion).forEach(
            (assetVersion) => {
                const assetBundle = this.downloadedAssetBundlesByVersion[assetVersion];
                const version = assetBundle.getVersion();
                if (version !== assetBundleToKeep.getVersion()) {
                    // Using rimraf specifically instead of shelljs.rm because despite using
                    // process.noAsar shelljs tried to remove files inside asar instead of just
                    // deleting the archive. `del` also could not delete asar archive. Rimraf is ok
                    // because it accepts custom fs object.
                    promises.push(
                        new Promise((resolve) => {
                            const pathToDelete = path.join(this.versionsDirectory, version);
                            rimrafWithRetries(pathToDelete, originalFs)
                                .then(() => {
                                    this.log.info(`pruned old version dir ${version}`);
                                    resolve({ pathToDelete, state: true });
                                }).catch((e) => {
                                    this.log.error(
                                        `error while pruning old version dir ${version}`
                                    );
                                    resolve({ pathToDelete, state: false, reason: e });
                                });
                        })
                    );
                    delete this.downloadedAssetBundlesByVersion[version];
                }
            }
        );
        return Promise.all(promises);
    }

    /**
     * Reads a network-tuning value from the app's desktop settings, falling back to the default.
     *
     * @param {String} name          - Field name in settings.json.
     * @param {Number} defaultValue  - Value to use when the field is absent or not a number.
     *
     * @returns {Number} - The timeout in milliseconds.
     * @private
     */
    resolveTimeout(name, defaultValue) {
        const configured = this.appSettings && this.appSettings[name];
        return typeof configured === 'number' && configured > 0 ? configured : defaultValue;
    }

    /**
     * Creates Download directory.
     *
     * @returns {boolean}
     * @private
     */
    makeDownloadDirectory() {
        try {
            if (!fs.existsSync(this.downloadDirectory)) {
                this.log.info('created download dir.');
                fs.mkdirSync(this.downloadDirectory);
            }
            return true;
        } catch (e) {
            this.log.debug(`creating download dir failed: ${e.message}`);
        }
        return false;
    }

    /**
     * Loads all downloaded asset bundles.
     *
     * @private
     */
    loadDownloadedAssetBundles() {
        fs.readdirSync(this.versionsDirectory).forEach((file) => {
            const directory = path.join(this.versionsDirectory, file);
            if (this.downloadDirectory !== directory
                && this.partialDownloadDirectory !== directory
                && originalFs.lstatSync(directory).isDirectory()
            ) {
                try {
                    const assetBundle = new AssetBundle(
                        this.log,
                        directory,
                        undefined,
                        this.initialAssetBundle
                    );
                    this.log.info(`got version: ${assetBundle.getVersion()} in ${file}`);
                    this.downloadedAssetBundlesByVersion[assetBundle.getVersion()] = assetBundle;
                } catch {
                    this.log.info(`broken version in directory: ${directory}`);
                }
            }
        });
    }

    /**
     * Releases the in-flight slot, but only if it still holds the download that is reporting.
     *
     * `didFail` and `didFinishDownloadingAssetBundle` used to clear the slot unconditionally, and
     * both are reached by callers that have no download of their own: the manifest fetch's own
     * `.catch`, the "no redownload of initial version" short-circuit, the already-downloaded-bundle
     * short-circuit. So a poll whose manifest fetch merely failed would release a DIFFERENT poll's
     * running download, putting the two guards in `checkForUpdates` straight back to sleep — the
     * next check for the same version would start a second download, and one for another version
     * would rename `Downloading` out from under the first. That is the very race assigning the
     * field was meant to close, so the slot is now released only by its own owner.
     *
     * The fix is the RELOCATION — clearing moved out of `didFail` and into the three points where a
     * download's own run actually ends. The identity test on top of it is belt and braces: all
     * three call sites are owner-invoked today, and a superseded downloader cannot reach any of
     * them (the cancel in `checkForUpdates` nulls the slot before the replacement claims it, and a
     * cancelled download's late responses and stall timer both return early on `cancelInvoked`).
     * So the non-matching branch has no reachable caller and no test covers it; it is here so that
     * a method named "release this downloader" is true in isolation rather than only by virtue of
     * invariants living in two other functions.
     *
     * @param {AssetBundleDownloader} downloader - Downloader whose run has ended.
     *
     * @private
     */
    releaseDownloader(downloader) {
        if (this.assetBundleDownloader === downloader) {
            this.assetBundleDownloader = null;
        }
    }

    /**
     * Failure handler.
     *
     * @param {string} cause - Error message.
     * @private
     */
    didFail(cause) {
        this.log.debug(`fail: ${cause}`);

        if (this.callback !== null) {
            this.callback.onError(cause);
        }
    }

    /**
     * Success handler.
     *
     * @param {AssetBundle} assetBundle      - Asset bundle which was downloaded.
     * @private
     */
    didFinishDownloadingAssetBundle(assetBundle) {
        if (this.callback !== null) {
            this.callback.onFinishedDownloadingAssetBundle(assetBundle);
        }
    }

    /**
     * Searches for a cached asset in all available bundles.
     *
     * @param {Asset} asset - Asset we are searching for.
     * @returns {Asset|null}
     * @private
     */
    cachedAssetForAsset(asset) {
        const bundles = Object.keys(this.downloadedAssetBundlesByVersion).reduce(
            (arr, key) => {
                arr.push(this.downloadedAssetBundlesByVersion[key]);
                return arr;
            },
            []
        );

        let cachedAsset = null;
        const assetFound = bundles.some((assetBundle) => {
            const candidate = assetBundle.cachedAssetForUrlPath(asset.urlPath, asset.hash);
            if (candidate !== null && canReuseCachedAsset(asset, candidate, false)) {
                cachedAsset = candidate;
                return true;
            }
            return false;
        });
        if (assetFound) {
            return cachedAsset;
        }

        if (this.partiallyDownloadedAssetBundle !== null) {
            const candidate = this.partiallyDownloadedAssetBundle
                .cachedAssetForUrlPath(asset.urlPath, asset.hash);
            if (candidate !== null && canReuseCachedAsset(asset, candidate, true)) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Prepares asset bundle downloader.
     *
     * @param {AssetBundle} assetBundle - Asset bundle to download.
     * @param {string}      baseUrl     - Url to meteor server.
     * @private
     */
    downloadAssetBundle(assetBundle, baseUrl) {
        const missingAssets = [];

        // `every` rather than `forEach`, so a failure ABORTS THE DOWNLOAD instead of just the
        // iteration (seed meteor-desktop-0cd8). Both failures below used to `didFail` and carry on:
        // the asset was then neither copied nor pushed onto missingAssets, so nothing downloaded it
        // either, the remaining assets finished normally, and the bundle was moved into `versions/`
        // and served MISSING that asset. It also emitted an error followed by onNewVersionReady for
        // the same check, which is the "exactly one outcome" contract Stage 4 established.
        const allAssetsPrepared = assetBundle.getOwnAssets().every((asset) => {
            // Create containing directories for the asset if necessary
            const containingDirectory = path.dirname(asset.getFile());

            try {
                fs.lstatSync(containingDirectory);
            } catch {
                try {
                    fs.mkdirSync(containingDirectory, { recursive: true });
                } catch {
                    this.didFail(`could not create containing directory: ${containingDirectory}`);
                    return false;
                }
            }

            // If we find a cached asset, we copy it.
            const cachedAsset = this.cachedAssetForAsset(asset);

            if (cachedAsset !== null) {
                try {
                    // A `desktop.asar` special case used to sit here, copying through an unawaited
                    // createReadStream().pipe(). It was residue of desktopHCP, removed in v6.0.0
                    // (commit 1bc104c) — only that feature ever put a desktop.asar into an HCP
                    // bundle. What makes it unreachable now is structural rather than historical:
                    // `cachedAssetForUrlPath` is an exact key lookup into `ownAssetsByURLPath` by
                    // the REQUESTED asset's urlPath, so a cached desktop.asar can only be returned
                    // for a request whose own urlPath is a desktop.asar path — and requested
                    // urlPaths come only from the server's `__browser/manifest.json` or from a
                    // program.json this module wrote from that body, neither of which Meteor ever
                    // fills with an asar. A stale pre-6.0.0 `versions/` directory is therefore dead
                    // weight on disk, never a lookup hit.
                    //
                    // It was also the one copy here that could not fail safely: stream errors are
                    // emitted a tick after this catch has returned, so they escaped both this try
                    // and the abort added for seed meteor-desktop-0cd8, and the pipe was not
                    // awaited even on success — the download could finish and promote the bundle
                    // while the copy was still in flight (seed meteor-desktop-1886). copyFileSync
                    // fails CLOSED instead: it throws synchronously, which aborts the download.
                    fs.copyFileSync(cachedAsset.getFile(), asset.getFile());
                } catch (e) {
                    this.didFail(e.message);
                    return false;
                }
            } else {
                missingAssets.push(asset);
            }
            return true;
        });

        // didFail has already reported the cause; going on would ship a bundle short of an asset.
        if (!allAssetsPrepared) {
            return;
        }

        // If all assets were cached, there is no need to start a download.
        if (missingAssets.length === 0) {
            this.didFinishDownloadingAssetBundle(assetBundle);
            return;
        }

        let assetBundleDownloader = new AssetBundleDownloader(
            this.log,
            this.configuration,
            assetBundle,
            baseUrl,
            missingAssets
        );

        // Stable handle for the watchdog: the success callback below nulls the `let`, and the timer
        // still has to be able to cancel the downloader it was armed for.
        const downloader = assetBundleDownloader;

        // Seed meteor-desktop-912a. This assignment is what makes `checkForUpdates`'s two guards
        // real: without it the field stayed null forever, so a poll landing mid-download neither
        // recognised a download of the same version already running nor cancelled one of a
        // different version — both then wrote into the same `Downloading` directory and
        // `moveExistingDownloadDirectoryIfNeeded` renamed it out from under whichever was still
        // running. Released by `releaseDownloader` at the three points where this download's own
        // run ends — NOT by `didFail`, which is reached by callers that have no download of their
        // own and would otherwise free another poll's slot.
        this.assetBundleDownloader = assetBundleDownloader;
        const stallTimeout = this.resolveTimeout('hcpStallTimeout', DEFAULT_HCP_STALL_TIMEOUT);

        // Download stall watchdog (seed meteor-desktop-5aa1). Re-armed on every completed asset, so
        // it measures "nothing finished in stallTimeout with 6 assets in flight" rather than total
        // download time — a slow but progressing download is never killed. Without it a hung asset
        // fetch leaves the queue undrained forever: onFinished never fires, no further event is
        // emitted, and the renderer sits on a dead progress bar until the user restarts.
        //
        // The handle stays a CLOSURE variable rather than a field on the manager even now that
        // `this.assetBundleDownloader` is assigned (seed meteor-desktop-912a). The two are not the
        // same mechanism and neither replaces the other: the field answers "is a download in
        // flight", and is deliberately cleared by any `didFail` — including a concurrent poll's
        // manifest fetch failing, which has nothing to do with this download. A watchdog parked
        // there would be disarmed by that unrelated failure, leaving the wedge it exists to catch
        // uncaught. One timer per download, owned by the download, is the invariant.
        /** @type {NodeJS.Timeout|null} */
        let stallTimer = null;
        const clearStallTimer = () => {
            if (stallTimer !== null) {
                clearTimeout(stallTimer);
                stallTimer = null;
            }
        };
        const armStallTimer = () => {
            clearStallTimer();
            stallTimer = setTimeout(() => {
                stallTimer = null;
                // Superseded, not stalled: `checkForUpdates` cancels this download when the server
                // moves to a different version, and the cancel cannot clear a timer it cannot see.
                // Reporting a failure here would hand the renderer a "stalled" error for a download
                // deliberately abandoned minutes earlier, for a version it is no longer waiting on.
                if (downloader.cancelInvoked) {
                    return;
                }
                // cancel() ends the queue but cannot abort requests already in flight. What stops
                // a late one from reaching onFinished after we have failed — and the renderer
                // hearing "download stalled" and then "new version ready" for the same download —
                // is the cancelInvoked guard at the top of the downloader's onResponse. One
                // mechanism, at the source, rather than a second one here.
                downloader.cancel();
                this.releaseDownloader(downloader);
                this.didFail(
                    `download of version ${assetBundle.getVersion()} stalled: `
                    + `no asset completed in ${stallTimeout}ms`
                );
            }, stallTimeout);
        };

        assetBundleDownloader.setCallbacks(
            () => {
                clearStallTimer();
                this.releaseDownloader(downloader);
                assetBundleDownloader = null;
                try {
                    this.moveDownloadedAssetBundleIntoPlace(assetBundle);
                    this.didFinishDownloadingAssetBundle(assetBundle);
                } catch (e) {
                    this.didFail(e);
                }
            },
            (cause) => {
                clearStallTimer();
                this.releaseDownloader(downloader);
                this.didFail(cause);
            },
            (bytesTransferred, bytesTotal) => {
                armStallTimer();
                if (this.callback !== null && this.callback.onDownloadProgress) {
                    this.callback.onDownloadProgress(bytesTransferred, bytesTotal);
                }
            }
        );
        // Announced only once a real download is committed to, and everything above this point can
        // still short-circuit: an asset that could not be prepared, every asset already cached, or
        // the bundle refused by `shouldDownloadBundleForManifest`. A consumer that blocked its UI on
        // a download that never starts would hang the app. (Line numbers deliberately omitted — the
        // previous version of this comment cited two that had already drifted.)
        if (this.callback !== null && this.callback.onDownloadStarted) {
            this.callback.onDownloadStarted(assetBundleDownloader.bytesTotal);
        }
        armStallTimer();
        assetBundleDownloader.resume();
    }

    /**
     * Move the downloaded asset bundle to a new directory named after the version.
     *
     * @param {AssetBundle} assetBundle - Asset bundle to move.
     * @private
     */
    moveDownloadedAssetBundleIntoPlace(assetBundle) {
        const version = assetBundle.getVersion();
        const versionDirectory = path.join(this.versionsDirectory, version);
        originalFs.renameSync(this.downloadDirectory, versionDirectory);
        assetBundle.didMoveToDirectoryAtUri(versionDirectory);
        this.downloadedAssetBundlesByVersion[version] = assetBundle;
    }

    /**
     * If there is an existing Downloading directory, move it
     * to PartialDownload and load the partiallyDownloadedAssetBundle so we
     * won't unnecessarily redownload assets.
     *
     * @private
     */
    moveExistingDownloadDirectoryIfNeeded() {
        if (fs.existsSync(this.downloadDirectory)) {
            if (fs.existsSync(this.partialDownloadDirectory)) {
                try {
                    // Using rimraf specifically instead of shelljs.rm because despite using
                    // process.noAsar shelljs tried to remove files inside asar instead of just
                    // deleting the archive. `del` also could not delete asar archive. Rimraf is ok
                    // because it accepts custom fs object.
                    originalFs.rmSync(this.partialDownloadDirectory, { recursive: true, force: true });
                } catch {
                    this.log.error('could not delete partial download directory.');
                    return;
                }
            }

            this.partiallyDownloadedAssetBundle = null;

            try {
                originalFs.renameSync(this.downloadDirectory, this.partialDownloadDirectory);
            } catch {
                this.log.error('could not rename existing download directory');
                return;
            }

            try {
                this.partiallyDownloadedAssetBundle = new AssetBundle(
                    this.log,
                    this.partialDownloadDirectory,
                    undefined,
                    this.initialAssetBundle
                );
            } catch {
                this.log.warn('could not load partially downloaded asset bundle.');
            }
        }
    }
}
export default AssetBundleManager;
