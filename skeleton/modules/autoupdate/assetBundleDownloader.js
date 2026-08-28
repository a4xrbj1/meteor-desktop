import crypto from 'crypto';
import fs from 'fs';
import url from 'url';
import { createRequire } from 'module';
import Queue from 'queue';
import IsDesktopInjector from './isDesktopInjector.js';
import utils from './utils.js';

const { modernUserAgent } = utils;

// Cap on assets fetched in parallel. `new Queue()` defaults to `concurrency: Infinity`
// (queue/index.js:18), so EVERY missing asset was requested at once: one HCP download of the
// yourdna.family bundle is a 285-request simultaneous burst at the Meteor server. Measured against
// production 2026-08-18, replaying this downloader's exact request shape — 5x sequential, 20 and 80
// concurrent were 100% 200, and the third consecutive 151-way burst returned 103x 200 and 48x 503.
// One shed asset fails the WHOLE bundle (verifyResponse -> didFail), and the app then stays on its
// baked bundle, because the reload is gated on `onNewVersionReady`, which a failed download never
// fires — so the user silently never receives the update. Seed meteor-desktop-3669. The staging half
// of the same bug was frontend-a312, seen there as a 429 and fixed only on the server side, which is
// why it resurfaced on production as a 503.
//
// 6 is deliberately far below the measured breaking point rather than just under it: the probe had
// the server to itself, real clients share it with live users and with each other.
const DOWNLOAD_CONCURRENCY = 6;

const require = createRequire(import.meta.url);

let originalFs = fs;
try {
    originalFs = require('original-fs');
} catch {
    // Falls back to fs outside Electron.
}

export default class AssetBundleDownloader {
    /**
     * Assets downloader - responsible for downloading an asset version.
     *
     * @param {object}      log           - Logger instance from loggerManager.
     * @param {object}      configuration - Configuration object.
     * @param {AssetBundle} assetBundle   - Parent asset bundle.
     * @param {string}      baseUrl       - Url of the meteor server.
     * @param {Asset}       missingAssets - Array of assets to download.
     * @constructor
     */
    constructor(log, configuration, assetBundle, baseUrl, missingAssets) {
        this.log = log.getLoggerFor('AssetBundleDownloader');
        this.log.debug(`downloader created for ${assetBundle.directoryUri}`);

        this.configuration = configuration;
        this.assetBundle = assetBundle;
        this.baseUrl = baseUrl;
        this.injector = new IsDesktopInjector();
        this.httpClient = globalThis.fetch;

        this.eTagWithSha1HashPattern = /"([0-9a-f]{40})"/;

        this.missingAssets = missingAssets;
        this.assetsDownloading = [];
        this.onFinished = null;
        this.onFailure = null;
        this.onProgress = null;
        // Byte totals for download progress. The total is summed HERE, at construction, because
        // `missingAssets` is spliced as each asset lands — by the time the download finishes the
        // array is empty and the total is unrecoverable.
        //
        // The field is `entrySize`, NOT `size`. assetManifest.js parses the manifest entry's
        // `size`, but assetBundle.js's Asset constructor stores it as `this.entrySize`
        // (assetBundle.js:29), and `missingAssets` holds Asset objects, not manifest entries.
        // Reading `asset.size` yields undefined for every asset, so both the total and every
        // increment silently become 0 — a download that reports 0 of 0 bytes forever. The
        // size-verification check further down this same file (`asset.entrySize !== body.length`)
        // already had it right.
        this.bytesTotal = missingAssets.reduce((sum, asset) => sum + (asset.entrySize || 0), 0);
        this.bytesTransferred = 0;
        this.cancelInvoked = false;

        this.queue = new Queue({ concurrency: DOWNLOAD_CONCURRENCY });
    }

    /**
     * Asset bundle getter.
     */
    getAssetBundle() {
        return this.assetBundle;
    }

    /**
     * Stores callbacks.
     *
     * @param {function} onFinished  - Callback for success.
     * @param {function} onFailure   - Callback for failure.
     * @param {function} [onProgress] - Optional (bytesTransferred, bytesTotal) progress callback,
     *                                  fired once per verified+written asset. Optional so existing
     *                                  callers keep working unchanged.
     */
    setCallbacks(onFinished, onFailure, onProgress) {
        this.onFinished = onFinished;
        this.onFailure = onFailure;
        this.onProgress = onProgress || null;
    }

    /**
     * Starts the download.
     */
    resume() {
        const self = this;

        this.log.verbose(
            `started downloading assets from bundle with version: ${this.assetBundle.getVersion()}`
        );

        /**
         * @param {Asset} asset  - Asset whose downloading failed.
         * @param {string} cause - The cause.
         */
        function onFailure(asset, cause) {
            self.assetsDownloading.splice(self.assetsDownloading.indexOf(asset), 1);

            if (!self.cancelInvoked) {
                self.didFail(`error downloading asset: ${asset.filePath}: ${cause}`);
            }
        }

        /**
         * @param {Asset} asset - Asset that was downloaded.
         * @param {Object} response - Response object from `fetch`.
         * @param {Buffer} body - Body of downloaded the file.
         */
        function onResponse(asset, response, body) {
            const fileContents = body;
            self.assetsDownloading.splice(self.assetsDownloading.indexOf(asset), 1);

            try {
                self.verifyResponse(response, asset, fileContents);
            } catch (e) {
                self.didFail(`failed at verifyResponse: ${e.message}`);
                return;
            }

            try {
                // Unfortunately on every hot code push we need to ensure that we will not loose
                // `Meteor.isDesktop`. Here we will inject it into the code that arrived from HCP.
                if (asset.fileType === 'js') {
                    const fileContentsString = fileContents.toString('utf-8');
                    const result = self.injector.processFileContents(fileContentsString);
                    if (result.injected || result.injectedStartupDidComplete) {
                        fs.writeFileSync(asset.getFile(), result.fileContents, 'utf-8');
                    } else {
                        fs.writeFileSync(asset.getFile(), fileContents);
                    }
                } else {
                    originalFs.writeFileSync(asset.getFile(), fileContents);
                }
            } catch (e) {
                self.didFail(`failed at injecting isDesktop and writing to disk: ${e.message}`);
                return;
            }

            // We don't have a hash for the index page, so we have to parse the runtime config
            // and compare autoupdateVersionCordova to the version in the manifest to verify
            // if we downloaded the expected version.
            if (asset.filePath === 'index.html') {
                const runtimeConfig = self.assetBundle.getRuntimeConfig();
                if (runtimeConfig !== null) {
                    try {
                        self.verifyRuntimeConfig(runtimeConfig);
                    } catch (e) {
                        self.didFail(`fail at verifyRuntimeConfig: ${e}`);
                        return;
                    }
                }
            }

            self.log.verbose(`saving ${asset.urlPath}`);

            self.missingAssets.splice(self.missingAssets.indexOf(asset), 1);

            // Emitted here rather than on response arrival: at this point the asset has been
            // verified and written, so the bytes are genuinely on disk. Reporting on arrival
            // would let progress run ahead of a download that then fails verification.
            self.bytesTransferred += (asset.entrySize || 0);
            if (self.onProgress) {
                self.onProgress(self.bytesTransferred, self.bytesTotal);
            }

            if (self.missingAssets.length === 0) {
                self.log.verbose(
                    'finished downloading new asset bundle version:'
                    + `${self.assetBundle.getVersion()}`
                );

                if (self.onFinished) {
                    self.onFinished();
                }
            }
        }

        this.missingAssets.forEach((asset) => {
            if (!~self.assetsDownloading.indexOf(asset)) {
                self.assetsDownloading.push(asset);
                const downloadUrl = self.downloadUrlForAsset(asset);
                self.queue.push((callback) => {
                    self.httpClient(downloadUrl, {
                        headers: { Connection: 'close', 'User-Agent': modernUserAgent }
                    })
                        .then((response) => Promise.all([response, response.arrayBuffer()]))
                        .then(([response, arrayBuffer]) => {
                            onResponse(asset, response, Buffer.from(arrayBuffer));
                            callback();
                        })
                        .catch((error) => {
                            onFailure(asset, error);
                            callback();
                        });
                });
            }
        });
        self.queue.start();
    }

    /**
     * Cancels downloading.
     */
    cancel() {
        this.cancelInvoked = true;
        this.queue.end();
    }

    /**
     * Computes a download url for asset.
     *
     * @param {Asset} asset - Asset for which the url is created.
     * @returns {string}
     * @private
     */
    downloadUrlForAsset(asset) {
        let { urlPath } = asset;

        // Remove leading / from URL path because the path should be
        // interpreted relative to the base URL.
        if (urlPath[0] === '/') {
            urlPath = urlPath.substring(1);
        }

        const builder = url.parse(url.resolve(this.baseUrl, urlPath));

        // To avoid inadvertently downloading the default index page when an asset
        // is not found, we add meteor_dont_serve_index=true to the URL unless we
        // are actually downloading the index page.
        if (asset.filePath !== 'index.html') {
            // legacy url.parse/format API: .query accepts an object for url.format
            builder.query = /** @type {any} */ ({ meteor_dont_serve_index: 'true' });
        }

        return url.format(builder);
    }

    /**
     * Verifies response from the server.
     *
     * @param {Object} response - Http response object.
     * @param {Asset}  asset    - Asset which was downloaded.
     * @param {Buffer} body     - Body of the file as a Buffer.
     * @private
     */
    verifyResponse(response, asset, body) {
        if (response.status !== 200) {
            throw new Error(
                `non-success status code ${response.status} for asset: ${asset.filePath}`
            );
        }

        // Strong integrity: verify the downloaded bytes against the manifest's
        // sha512 subresource-integrity digest (sri = base64(sha512(content))).
        // Meteor 3.x emits sri for cacheable client assets; the legacy `hash`
        // field is NOT a content digest of the served bytes (verified against
        // production), so only sri can be checked here. This catches a corrupt
        // or wrong asset even when the server sends no ETag (seed
        // meteor-desktop-1820). Runs on the raw body, before isDesktop injection.
        if (asset.sri) {
            const actualSri = crypto.createHash('sha512').update(body).digest('base64');
            if (actualSri !== asset.sri) {
                throw new Error(
                    `sri mismatch for asset: ${asset.filePath} - expected sha512: `
                    + `${asset.sri} != ${actualSri}`
                );
            }
        }

        // If we have a hash for the asset, and the ETag header also specifies
        // a hash, we compare these to verify if we received the expected asset version.
        const expectedHash = asset.hash;

        if (expectedHash !== null) {
            const eTag = response.headers.get('etag');

            if (typeof eTag === 'string') {
                const matches = eTag.match(this.eTagWithSha1HashPattern);

                if (this.eTagWithSha1HashPattern.test(eTag)) {
                    const actualHash = matches[1];

                    if (actualHash !== expectedHash) {
                        throw new Error(
                            `hash mismatch for asset: ${asset.filePath} - expected hash:`
                            + `${expectedHash} != ${actualHash}`
                        );
                    } else if (asset.entrySize !== body.length) {
                        // Size mismatch: log but do not throw, as the bundle is still usable.
                        this.log.debug(`wrong size for: ${asset.filePath} - expected: `
                            + `${asset.entrySize} != ${body.length}`);
                    }
                } else {
                    this.log.warn(`invalid etag format for ${asset.urlPath}: ${eTag}`);
                }
            } else {
                this.log.warn(`no eTag served for ${asset.urlPath}`);
            }
        }
    }

    /**
     * Fail handler.
     *
     * @param {string} cause - Error message;
     * @private
     */
    didFail(cause) {
        if (this.cancelInvoked) return;

        this.cancel();

        this.log.debug(`failure: ${cause}`);
        if (this.onFailure !== null) {
            this.onFailure(cause);
        }
    }

    /**
     * Verifies runtime config.
     *
     * @param {Object} runtimeConfig - Runtime config.
     * @private
     */
    verifyRuntimeConfig(runtimeConfig) {
        const expectedVersion = this.assetBundle.getVersion();
        // Meteor 3.x web.browser leaves the legacy top-level autoupdateVersion(Cordova)
        // fields null even though the never-null per-arch version is published under
        // autoupdate.versions['web.browser'].version (== the manifest version we
        // fetched). Fall back to it so the integrity check has a real version to
        // compare against (seed meteor-desktop-e490 G2).
        const perArchVersion = runtimeConfig.autoupdate
            && runtimeConfig.autoupdate.versions
            && runtimeConfig.autoupdate.versions['web.browser']
            && runtimeConfig.autoupdate.versions['web.browser'].version;
        const actualVersion = runtimeConfig.autoupdateVersionCordova
            || runtimeConfig.autoupdateVersion
            || perArchVersion;

        if (!actualVersion) {
            throw new Error(
                'runtime config missing autoupdateVersionCordova, autoupdateVersion and '
                + 'autoupdate.versions[web.browser].version — cannot verify downloaded bundle version'
            );
        }

        if (actualVersion !== expectedVersion) {
            throw new Error(
                `version mismatch for index page, expected: ${expectedVersion}`
                + `, actual: ${actualVersion}`
            );
        }

        if (!('ROOT_URL' in runtimeConfig)) {
            throw new Error('could not find ROOT_URL in downloaded asset bundle');
        }

        const rootUrlString = runtimeConfig.ROOT_URL;

        const rootUrl = url.parse(rootUrlString);
        const previousRootUrl = url.parse(this.configuration.rootUrlString);

        if (previousRootUrl.hostname !== 'localhost' && rootUrl.hostname === 'localhost') {
            throw new Error(
                'ROOT_URL in downloaded asset bundle would change current ROOT_URL '
                + 'to localhost. Make sure ROOT_URL has been configured correctly on the server.'
            );
        }

        if (!('appId' in runtimeConfig)) {
            throw new Error('could not find appId in downloaded asset bundle.');
        }

        const { appId } = runtimeConfig;

        if (appId !== this.configuration.appId) {
            throw new Error(
                'appId in downloaded asset bundle does not match current appId. Make sure the'
                + ` server at ${rootUrlString} is serving the right app.`
            );
        }
    }
}
