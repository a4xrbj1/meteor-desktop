import crypto from 'crypto';

/**
 * Represents single file in the manifest.
 *
 * @param {object} manifestEntry
 * @param {string} manifestEntry.path
 * @param {string} manifestEntry.url
 * @param {string} manifestEntry.type
 * @param {number} manifestEntry.size
 * @param {boolean}   manifestEntry.cacheable
 * @param {string} manifestEntry.hash
 * @param {string} manifestEntry.sri
 * @param {string} manifestEntry.sourceMap
 * @param {string} manifestEntry.sourceMapUrl
 *
 * @property {string} filePath
 * @property {string} urlPath
 * @property {string} fileType
 * @property {number} size
 * @property {boolean}   cacheable
 * @property {string} hash
 * @property {string} sri
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
        // sri = base64(sha512(content)) — the only manifest field that is a
        // verifiable digest of the served bytes (the legacy `hash` is not).
        sri: manifestEntry.sri || null,
        sourceMapFilePath: manifestEntry.sourceMap || null,
        sourceMapUrlPath: manifestEntry.sourceMapUrl || null
    });
}

/**
 * Represents a program.json app manifest.
 *
 * @param {Object} logger         - Logger instance.
 * @param {string} manifestSource - Manifest source.
 * @param {String} [origin]       - Where the manifest came from: `served` (fetched from the Meteor
 *                                  server) or `bundled` (read off disk). Governs only how loud the
 *                                  missing-version fallback is; `served` is the default so a new
 *                                  call site that forgets to say keeps the warning.
 *
 * @property {string} version
 * @property {string|null} minDesktopVersion
 *
 * @constructor
 */
export default function AssetManifest(logger, manifestSource, origin = 'served') {
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
         * @property {string=} minDesktopVersion
         * @property {Object=} PUBLIC_SETTINGS
         * @property {Array} manifest
         */
        json = JSON.parse(manifestSource);
        format = json.format || null;

        if (format !== null && format !== 'web-program-pre1') {
            error(`The asset manifest format is incompatible: ${format}`);
        }
        if (!('version' in json) || json.version === null) {
            // Derive a stable version from a SHA-256 hash of the manifest content.
            //
            // For a BUNDLED manifest this is the normal case, not a defect. Meteor's build never
            // writes `version` into program.json on disk: `webapp` attaches lazy version getters to
            // WebApp.clientPrograms[arch] and materialises them only when it serves
            // /__<arch>/manifest.json (webapp_server.js, `newProgram.version = () => ...` and the
            // staticFiles[manifestUrl] handler). So every embedded bundle lands here, and shouting
            // about it on every startup is how seed meteor-desktop-e490 came to record a
            // non-existent "rspack does not populate clientPrograms" root cause. Measured against
            // production 2026-08-28: the SERVED manifest carries a real, changing
            // WebAppHashing.calculateClientHash value, and only the on-disk artifact lacks one.
            //
            // For a SERVED manifest the field really should be there, so that stays a warning.
            const derivedVersion = crypto.createHash('sha256')
                .update(manifestSource).digest('hex').substring(0, 40);
            const message = `asset manifest has no version field — derived hash version: ${derivedVersion}`;
            if (origin === 'bundled') {
                log.debug(`${message} (normal for a bundled manifest — Meteor adds the version at serve time)`);
            } else {
                log.warn(message);
            }
            this.version = derivedVersion;
        } else {
            this.version = json.version;
        }

        // Minimum NATIVE (Electron shell) app version this JS bundle requires — the native-vs-JS
        // update split of seed meteor-desktop-0a0e. Optional and absent by default: a bundle that
        // does not declare one is accepted by every native, so no existing app changes behaviour.
        // Two accepted locations, in precedence order:
        //   1. top level, for a server that grows an explicit field;
        //   2. PUBLIC_SETTINGS, i.e. `Meteor.settings.public.minDesktopVersion` — the only one a
        //      consuming app can publish TODAY with no server-code change (verified against the
        //      live production `/__browser/manifest.json`, which carries PUBLIC_SETTINGS and has
        //      no cordovaCompatibilityVersions).
        this.minDesktopVersion = json.minDesktopVersion
            || (json.PUBLIC_SETTINGS && json.PUBLIC_SETTINGS.minDesktopVersion)
            || null;

        if (!Array.isArray(json.manifest)) {
            error(`asset manifest 'manifest' field is not an array (got: ${typeof json.manifest})`);
        }

        const allWhereValues = [...new Set(json.manifest.map((e) => e.where))];
        this.entries = json.manifest
            .filter((manifestEntry) => manifestEntry.where === 'client')
            .map((manifestEntry) => new ManifestEntry(manifestEntry));

        if (this.entries.length === 0) {
            error(
                'asset manifest has no \'client\' entries after filtering — '
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
 * @property {string|null} minDesktopVersion
 */
