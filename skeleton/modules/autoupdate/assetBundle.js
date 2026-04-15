import path from 'path';
import fs from 'fs';
import url from 'url';

import AssetManifest from './assetManifest.js';

/**
 * Represent single asset in the bundle.
 *
 * @property {string} filePath
 * @property {string} urlPath
 * @property {string} fileType
 * @property {number} size
 * @property {bool}   cacheable
 * @property {string} hash
 * @property {string} sourceMapFilePath
 * @property {string} sourceMapUrlPath
 * @property {AssetBundle} bundle
 * @constructor
 */
function Asset(filePath, urlPath, fileType, cacheable, hash, sourceMapUrlPath, size, bundle) {
    this.filePath = filePath;
    this.urlPath = urlPath;
    this.fileType = fileType;
    this.cacheable = cacheable;
    this.hash = hash;
    this.entrySize = size;
    this.sourceMapUrlPath = sourceMapUrlPath;
    this.bundle = bundle;

    this.getFile = function getFile() {
        return path.join(this.bundle.directoryUri, filePath);
    };
}

export default class AssetBundle {
    /**
     * Represents assets bundle.
     *
     * @param {object}         log               - Winston reference.
     * @param {string}         directoryUri      - Where the bundle lies in the file system.
     * @param {AssetManifest=} manifest          - Bundle's manifest.
     * @param {AssetBundle=}   parentAssetBundle - Parent asset bundle.
     * @constructor
     */
    constructor(log, directoryUri, manifest, parentAssetBundle) {
        this.log = log.getLoggerFor('AssetBundle');
        this.log.verbose(`making bundle object for ${directoryUri}`);

        this.directoryUri = directoryUri;

        this.runtimeConfig = null;
        this.appId = null;
        this.rootUrlString = null;
        this.rootUrlString = null;
        this.matcher = /__meteor_runtime_config__ = JSON.parse\(decodeURIComponent\("([^"]*)"\)\)/;

        if (manifest) {
            this.log.debug(`manifest has ${manifest.entries.length} entries`);
        }

        this.parentAssetBundle = parentAssetBundle;

        if (manifest === undefined) {
            this.log.verbose(`loading manifest from ${directoryUri}`);
            this.manifest = this.loadAssetManifest();
        } else {
            this.manifest = manifest;
        }

        this.version = this.manifest.version;

        this.ownAssetsByURLPath = {};

        // Filter assets that are only in this bundle. Rest can be taken from the parent.
        this.manifest.entries.forEach((entry) => {
            const urlPath = new url.URL(entry.urlPath, 'http://localhost').pathname;

            if (parentAssetBundle === undefined
                || parentAssetBundle.cachedAssetForUrlPath(urlPath, entry.hash) === null) {
                this.addAsset(new Asset(
                    entry.filePath,
                    urlPath,
                    entry.fileType,
                    entry.cacheable,
                    entry.hash,
                    entry.sourceMapUrlPath,
                    entry.size,
                    this
                ));
            }

            if (entry.sourceMapFilePath !== null && entry.sourceMapUrlPath !== null) {
                if (parentAssetBundle === undefined
                    || parentAssetBundle
                        .cachedAssetForUrlPath(entry.sourceMapUrlPath, null) === null) {
                    this.addAsset(new Asset(
                        entry.sourceMapFilePath,
                        entry.sourceMapUrlPath,
                        'json',
                        true,
                        null,
                        null,
                        entry.size,
                        this
                    ));
                }
            }
        });

        const indexFile = new Asset('index.html', '/', 'html', false, null, null, null, this);
        this.addAsset(indexFile);
        this.indexFile = indexFile;
    }

    /**
     * Get index.html path.
     * @returns {string}
     */
    getIndexFile() {
        return this.indexFile;
    }

    /**
     * Directory uri getter.
     * @returns {string}
     */
    getDirectoryUri() {
        return this.directoryUri;
    }

    /**
     * Parent asset bundle getter.
     * @returns {null|AssetBundle}
     */
    getParentAssetBundle() {
        return this.parentAssetBundle;
    }

    /**
     * Returns an cacheable or hash equal asset.
     *
     * @param {string}      urlPath - The url path of the asset.
     * @param {string|null} hash    - Hash of the asset.
     * @returns {null|Asset}
     */
    cachedAssetForUrlPath(urlPath, hash) {
        if (!(urlPath in this.ownAssetsByURLPath)) return null;
        const asset = this.ownAssetsByURLPath[urlPath];

        // If the asset is not cacheable, we require a matching hash.
        if ((asset.cacheable && hash === null) || (asset.hash !== null && asset.hash === hash)) {
            return asset;
        }

        return null;
    }

    /**
     * Returns an array of own assets.
     *
     * @returns {Array}
     */
    getOwnAssets() {
        return Object.keys(this.ownAssetsByURLPath)
            .reduce((arr, key) => {
                arr.push(this.ownAssetsByURLPath[key]);
                return arr;
            }, []);
    }

    /**
     * Version getter.
     * @returns {string}
     */
    getVersion() {
        return this.version;
    }

    /**
     * Loads runtime config.
     *
     * @returns {Object}
     */
    getRuntimeConfig() {
        if (this.runtimeConfig === null) {
            this.runtimeConfig = this.loadRuntimeConfig(
                path.join(this.directoryUri, this.indexFile.filePath)
            );
        }
        return this.runtimeConfig;
    }

    /**
     * App id getter.
     *
     * @returns {String}
     */
    getAppId() {
        if (this.appId === null) {
            const runtimeConfig = this.getRuntimeConfig();
            if (runtimeConfig !== null) {
                if (!('appId' in runtimeConfig)) {
                    this.log.error('error reading APP_ID from runtime config');
                } else {
                    this.appId = runtimeConfig.appId;
                }
            }
        }
        return this.appId;
    }

    /**
     * Return ROOT_URL from runtime config.
     *
     * @returns {string}
     */
    getRootUrlString() {
        if (this.rootUrlString === null) {
            const runtimeConfig = this.getRuntimeConfig();
            if (runtimeConfig !== null) {
                if (!('ROOT_URL' in runtimeConfig)) {
                    this.log.error('error reading ROOT_URL from runtime config');
                } else {
                    this.rootUrlString = runtimeConfig.ROOT_URL;
                }
            }
        }
        return this.rootUrlString;
    }

    /**
     * Changes bundle directory uri.
     *
     * @param {string} directoryUri - New directory path.
     */
    didMoveToDirectoryAtUri(directoryUri) {
        this.directoryUri = directoryUri;
    }

    /**
     * Returns asset queried by url path.
     * !UNUSED! Left in case of implementation change.
     *
     * @param {string} urlPath - Url path of the asset.
     *
     * @returns {Asset|null}
     */
    assetForUrlPath(urlPath) {
        let asset = null;
        if (urlPath in this.ownAssetsByURLPath) {
            asset = this.ownAssetsByURLPath[urlPath];
        } else if (this.parentAssetBundle) {
            asset = this.parentAssetBundle.assetForUrlPath(urlPath);
        }
        return asset;
    }

    /**
     * Load this bundle's asset manifest.
     *
     * @private
     * @returns {AssetManifest}
     */
    loadAssetManifest() {
        const manifestPath = path.join(this.directoryUri, 'program.json');
        try {
            return new AssetManifest(
                this.log,
                fs.readFileSync(manifestPath, 'UTF-8')
            );
        } catch (e) {
            const msg = `error loading asset manifest: ${e.message}`;
            this.log.error(msg);
            this.log.debug(e);
            throw new Error(msg);
        }
    }

    /**
     * Extracts and parses runtime config.
     * TODO: no negative path errors in case loadRuntimeConfig fails?
     *
     * @param {string} index - Path for index.html.
     * @private
     * @returns {null}
     */
    loadRuntimeConfig(index) {
        let content;
        try {
            content = fs.readFileSync(index, 'UTF-8');
        } catch (e) {
            this.log.error(`error loading index file: ${e.message}`);
            return null;
        }

        if (!this.matcher.test(content)) {
            this.log.error('could not find runtime config in index file');
            return null;
        }

        try {
            const matches = content.match(this.matcher);
            return JSON.parse(decodeURIComponent(matches[1]));
        } catch (e) {
            this.log.error('could not find runtime config in index file');
            return null;
        }
    }

    /**
     * Adds an asset to own assets collection.
     *
     * @param {Asset} asset - Asset to add.
     * @private
     */
    addAsset(asset) {
        this.ownAssetsByURLPath[asset.urlPath] = asset;
    }
}
