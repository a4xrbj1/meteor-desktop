import crypto from 'crypto';

/**
 * Represents single file in the manifest.
 *
 * @param {object} manifestEntry
 * @param {string} manifestEntry.path
 * @param {string} manifestEntry.url
 * @param {string} manifestEntry.type
 * @param {number} manifestEntry.size
 * @param {bool}   manifestEntry.cacheable
 * @param {string} manifestEntry.hash
 * @param {string} manifestEntry.sourceMap
 * @param {string} manifestEntry.sourceMapUrl
 *
 * @property {string} filePath
 * @property {string} urlPath
 * @property {string} fileType
 * @property {number} size
 * @property {bool}   cacheable
 * @property {string} hash
 * @property {string} sourceMapFilePath
 * @property {string} sourceMapUrlPath
 * @constructor
 */
function ManifestEntry(manifestEntry) {
    Object.assign(this, {
        filePath: manifestEntry.path,
        urlPath: manifestEntry.url,
        fileType: manifestEntry.type,
        size: manifestEntry.size,
        cacheable: manifestEntry.cacheable,
        hash: manifestEntry.hash || null,
        sourceMapFilePath: manifestEntry.sourceMap || null,
        sourceMapUrlPath: manifestEntry.sourceMapUrl || null
    });
}

/**
 * Represents a program.json app manifest.
 *
 * @param {Object} logger         - Logger instance.
 * @param {string} manifestSource - Manifest source.
 *
 * @property {string} version
 *
 * @constructor
 */
export default function AssetManifest(logger, manifestSource) {
    const log = logger.getLoggerFor('AssetManifest');
    let json;
    let format;

    function error(msg) {
        log.error(msg);
        throw new Error(msg);
    }

    try {
        /**
         * @type object
         * @property {string} format
         * @property {string|null} version
         * @property {Array} manifest
         */
        json = JSON.parse(manifestSource);
        format = json.format || null;

        if (format !== null && format !== 'web-program-pre1') {
            error(`The asset manifest format is incompatible: ${format}`);
        }
        if (!('version' in json) || json.version === null) {
            // Meteor 3.x omits the version field from program.json.
            // Derive a stable version from a SHA-256 hash of the manifest content.
            const derivedVersion = crypto.createHash('sha256')
                .update(manifestSource).digest('hex').substring(0, 40);
            log.warn(`asset manifest has no version field — derived hash version: ${derivedVersion}`);
            this.version = derivedVersion;
        } else {
            this.version = json.version;
        }

        if (!Array.isArray(json.manifest)) {
            error(`asset manifest 'manifest' field is not an array (got: ${typeof json.manifest})`);
        }

        const allWhereValues = [...new Set(json.manifest.map((e) => e.where))];
        this.entries = json.manifest
            .filter((manifestEntry) => manifestEntry.where === 'client')
            .map((manifestEntry) => new ManifestEntry(manifestEntry));

        if (this.entries.length === 0) {
            error(
                `asset manifest has no 'client' entries after filtering — `
                + `'where' values found: [${allWhereValues.join(', ')}]`
            );
        }

        log.debug(`${this.entries.length} entries. (Version: ${this.version})`);
    } catch (e) {
        error(`error parsing asset manifest: ${e.message}`);
    }
}

/**
 * @typedef {Object} AssetManifest
 * @property {string} version
 */
