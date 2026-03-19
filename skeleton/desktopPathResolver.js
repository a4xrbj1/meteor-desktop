import crypto from 'crypto';
import path, { join } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default class DesktopPathResolver {
    /**
     * Returns the initial bundle file paths used to resolve runtime bundle metadata.
     * Falls back to the unpacked meteor/ directory when meteor.asar does not exist.
     *
     * @returns {{asarPath: string, manifestPath: string, indexPath: string, desktopSettingsPath: string}}
     */
    static getInitialBundlePaths() {
        const asarPath = path.resolve(join(__dirname, '..', 'meteor.asar'));
        const meteorRoot = fs.existsSync(asarPath)
            ? asarPath
            : path.resolve(join(__dirname, '..', 'meteor'));

        return {
            asarPath,
            manifestPath: path.join(meteorRoot, 'program.json'),
            indexPath: path.join(meteorRoot, 'index.html'),
            desktopSettingsPath: path.resolve(join(__dirname, '..', 'desktop.asar', 'settings.json'))
        };
    }

    /**
     * Reads a json file.
     * @returns {Object}
     */
    static readJsonFile(jsonFilePath) {
        try {
            return JSON.parse(fs.readFileSync(jsonFilePath, 'UTF-8'));
        } catch (e) {
            return {};
        }
    }

    /**
     * Reads meteor app version from the initial asset bundle.
     * Falls back to the unpacked meteor/ directory when meteor.asar does not exist.
     * When program.json has no version field (Meteor 3.x), derives a stable version
     * from a SHA-256 hash of the manifest file content.
     * @returns {string|undefined}
     */
    static readInitialAssetBundleVersion() {
        const { manifestPath } = DesktopPathResolver.getInitialBundlePaths();

        let content;
        try {
            content = fs.readFileSync(manifestPath, 'UTF-8');
        } catch (e) {
            return undefined;
        }

        let parsed = {};
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            // fall through
        }

        if (parsed.version != null) {
            return parsed.version;
        }

        // Meteor 3.x omits version; derive stable version from manifest content hash.
        const derivedHash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 40);
        // eslint-disable-next-line no-console
        console.warn(
            `[DesktopPathResolver] no version in manifest at ${manifestPath}`
            + ` — using derived hash version: ${derivedHash}`
        );
        return derivedHash;
    }

    /**
     * Reads a stable signature for the embedded bootstrap state.
     * It covers the files that decide startup semantics:
     * - meteor program.json
     * - meteor index.html
     * - desktop.asar settings.json
     *
     * This is stricter than the manifest version/hash alone and lets us invalidate
     * stale persisted autoupdate state when the embedded bootstrap changes without
     * producing a distinct downloaded-bundle version.
     *
     * @returns {string|undefined}
     */
    static readInitialAssetBundleSignature() {
        const {
            manifestPath,
            indexPath,
            desktopSettingsPath
        } = DesktopPathResolver.getInitialBundlePaths();

        return DesktopPathResolver.readAssetBundleSignatureFromPaths(
            manifestPath,
            indexPath,
            desktopSettingsPath
        );
    }

    /**
     * Reads a stable bootstrap signature for any asset bundle root.
     * The bundle root can be either a directory or an asar archive path.
     *
     * @param {string} bundleRootPath - Root directory or asar archive containing the bundle.
     * @param {string} [desktopSettingsPath] - Optional desktop settings file to fold into the signature.
     *
     * @returns {string|undefined}
     */
    static readAssetBundleSignature(bundleRootPath, desktopSettingsPath) {
        const manifestPath = path.join(bundleRootPath, 'program.json');
        const indexPath = path.join(bundleRootPath, 'index.html');

        return DesktopPathResolver.readAssetBundleSignatureFromPaths(
            manifestPath,
            indexPath,
            desktopSettingsPath
        );
    }

    /**
     * Reads a stable signature for the supplied bootstrap files.
     *
     * @param {string} manifestPath - Path to program.json.
     * @param {string} indexPath - Path to index.html.
     * @param {string} [desktopSettingsPath] - Optional desktop settings file.
     *
     * @returns {string|undefined}
     */
    static readAssetBundleSignatureFromPaths(manifestPath, indexPath, desktopSettingsPath) {
        const parts = [];
        const files = [manifestPath, indexPath, desktopSettingsPath].filter(Boolean);

        files.forEach((filePath) => {
            try {
                parts.push(fs.readFileSync(filePath, 'UTF-8'));
            } catch (e) {
                // Skip unreadable files so dev/test environments without desktop.asar still get
                // a stable signature from the bootstrap files that do exist.
            }
        });

        if (parts.length === 0) {
            return undefined;
        }

        return crypto
            .createHash('sha256')
            .update(parts.join('\n---meteor-desktop-bootstrap-boundary---\n'))
            .digest('hex');
    }

    /**
     * Tries to read information about bundled desktop version.
     *
     * @param {string} userDataDir - user data path
     * @param {string} version     - meteor app version
     * @returns {Object}
     */
    static readDesktopVersionInfoFromBundle(userDataDir, version) {
        return DesktopPathResolver
            .readJsonFile(join(userDataDir, 'versions', version, '_desktop.json'));
    }

    /**
     * Decides where the current desktop.asar lies. Takes into account desktopHCP.
     * Also supports falling back to last known good version from Meteor mechanism.
     *
     * @param {string} userDataDir - user data path
     * @param {Log}    log         - App's logger instance
     */
    static resolveDesktopPath(userDataDir, log) {
        // TODO: kinda the same logic is in the autoupdate module - extract it to common place.

        let desktopPath = path.resolve(join(__dirname, '..', 'desktop.asar'));

        const initialDesktopVersion = DesktopPathResolver.readJsonFile(join(desktopPath, 'settings.json')).desktopVersion;

        log.info('initial desktop version is ', initialDesktopVersion);

        // Read meteor's initial asset bundle version.
        const initialVersion = DesktopPathResolver.readInitialAssetBundleVersion();
        const initialSignature = DesktopPathResolver.readInitialAssetBundleSignature();

        this.autoupdate = null;
        const autoupdateConfig = DesktopPathResolver.readJsonFile(join(userDataDir, 'autoupdate.json'));

        if (autoupdateConfig.lastSeenInitialVersion !== initialVersion) {
            log.info('will use desktop.asar from initial version because the initial version '
            + `of meteor app has changed: ${desktopPath}`);
            return desktopPath;
        }

        if (autoupdateConfig.lastSeenInitialSignature
            && initialSignature
            && autoupdateConfig.lastSeenInitialSignature !== initialSignature
        ) {
            log.info('will use desktop.asar from initial version because the embedded bootstrap '
                + `signature of meteor app has changed: ${desktopPath}`);
            return desktopPath;
        }

        if (autoupdateConfig.lastDownloadedVersion) {
            // We have a last downloaded version.
            if (~autoupdateConfig.blacklistedVersions.indexOf(
                autoupdateConfig.lastDownloadedVersion
            )
            ) {
                // If it is blacklisted lets check if we have last known good version.
                if (autoupdateConfig.lastKnownGoodVersion) {
                    // But is the last know good version different from the initial version?
                    if (autoupdateConfig.lastKnownGoodVersion
                        !== autoupdateConfig.lastSeenInitialVersion
                    ) {
                        const desktopVersion = DesktopPathResolver.readDesktopVersionInfoFromBundle(
                            userDataDir,
                            autoupdateConfig.lastKnownGoodVersion
                        );

                        // TODO: can we assume that desktopHCP is on?
                        if (desktopVersion.version) {
                            if (desktopVersion.version !== initialDesktopVersion) {
                                desktopPath = path.resolve(join(
                                    userDataDir,
                                    `${desktopVersion.version}_desktop.asar`
                                ));
                                log.warn('will use desktop.asar from last known good version '
                                    + `at: ${desktopPath}`);
                            } else {
                                log.warn('will use desktop.asar from initial version because '
                                    + 'last known good version of meteor app is using it: '
                                    + `${desktopPath}`);
                            }
                        } else {
                            log.warn('will use desktop.asar from initial version because last '
                                + 'known good version of meteor app does not contain new desktop '
                                + `version : ${desktopPath}`);
                        }
                    } else {
                        log.warn('will use desktop.asar from last known good version which is '
                            + `apparently the initial bundle: ${desktopPath}`);
                    }
                } else {
                    log.warn('will use desktop.asar from initial version as a fallback: '
                        + `${desktopPath}`);
                }
            } else if (autoupdateConfig.lastDownloadedVersion
                    !== autoupdateConfig.lastSeenInitialVersion
            ) {
                const desktopVersion = this.readDesktopVersionInfoFromBundle(
                    userDataDir,
                    autoupdateConfig.lastDownloadedVersion
                );
                if (desktopVersion.version) {
                    if (desktopVersion.version !== initialDesktopVersion) {
                        desktopPath = path.resolve(join(
                            userDataDir,
                            `${desktopVersion.version}_desktop.asar`
                        ));
                        log.info('will use desktop.asar from last downloaded version '
                            + `at: ${desktopPath}`);
                    } else {
                        log.info('will use desktop.asar from initial version because last '
                            + `downloaded version is using it: ${desktopPath}`);
                    }
                } else {
                    log.info('will use desktop.asar from initial version because last '
                        + 'downloaded version does not contain new desktop version: '
                        + `${desktopPath}`);
                }
            } else {
                log.info('will use desktop.asar from last downloaded version which is '
                    + `apparently the initial bundle: ${desktopPath}`);
            }
        } else {
            log.info(`using desktop.asar from initial bundle: ${desktopPath}`);
        }
        return desktopPath;
    }
}
