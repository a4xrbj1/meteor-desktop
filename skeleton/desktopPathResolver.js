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
                parts.push(fs.readFileSync(filePath, 'utf-8'));
            } catch {
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
     * Returns the path to the embedded desktop.asar.
     * desktopHCP was removed in v6.0.0 — the embedded bundle is always used.
     *
     * @param {string} userDataDir - user data path (unused, kept for signature compatibility)
     * @param {Log}    log         - App's logger instance
     *
     * @returns {string}
     */
    static resolveDesktopPath(userDataDir, log) {
        const desktopPath = path.resolve(join(__dirname, '..', 'desktop.asar'));
        log.info(`using embedded desktop.asar: ${desktopPath}`);
        return desktopPath;
    }
}
