import fs from 'fs';

/**
 * Simple wrapper for native fs.rmSync with additional retries in case of failure.
 * It is useful when something is concurrently reading the dir you want to remove.
 */
function rimrafWithRetries(path, optionsOrFs) {
    let fsToUse = fs;
    if (optionsOrFs && optionsOrFs.unlinkSync) {
        fsToUse = optionsOrFs;
    }
    let retries = 0;
    return new Promise((resolve, reject) => {
        function rm() {
            try {
                fsToUse.rmSync(path, { recursive: true, force: true });
                resolve();
            } catch (e) {
                retries += 1;
                if (retries < 5) {
                    setTimeout(() => {
                        rm();
                    }, 100);
                } else {
                    reject(e);
                }
            }
        }
        rm();
    });
}

/**
 * Meteor picks the client arch from the request's User-Agent (`modern-browsers`), and HCP
 * always fetches its manifest from the modern `/__browser/` endpoint. So the asset requests
 * have to look modern too: with no User-Agent the server answers with `web.browser.legacy`
 * bytes, whose sha512 can never match the modern manifest's sri, and the whole bundle is
 * rejected at verifyResponse (seed frontend-7c13, measured on staging: 546244 legacy bytes
 * vs the manifest's 471826). `process.versions.chrome` is always set in the Electron main
 * process; the fallback only applies outside Electron (tests, tooling).
 *
 * @type {string}
 */
const modernUserAgent = `Mozilla/5.0 (${process.platform}) AppleWebKit/537.36 (KHTML, like Gecko) `
    + `Chrome/${process.versions.chrome || '120.0.0.0'} meteor-desktop-hcp Safari/537.36`;

/**
 * Parses one dot-separated version component into a number, treating anything unparseable as 0.
 * A leading `v` is stripped, so a `v`-prefixed tag does not read as `0`.
 *
 * @param {String} part - One component of a version string.
 *
 * @returns {Number} - The numeric value.
 */
const toVersionPart = function (part) {
    return parseInt(String(part).replace(/^v/i, ''), 10) || 0;
};

/**
 * Splits a version string into its numeric components, dropping any prerelease suffix AND any
 * build metadata. Both separators matter: `v5.3.0` must not read as `[0, 3, 0]` and
 * `5.3.0+build.7` must not read as `[5, 3, 0, 7]` — the first would refuse every floored bundle
 * on a correctly-versioned app, which is the exact pathology the ordered comparison exists to
 * avoid.
 *
 * @param {String} version - Version string, e.g. `v5.1.4-beta.1` or `5.1.4+build.7`.
 *
 * @returns {Array<Number>} - The numeric components, e.g. `[5, 1, 4]`.
 */
const parseCoreVersion = function (version) {
    return String(version).split(/[-+]/)[0].split('.').map(toVersionPart);
};

/**
 * Compares the numeric core (`major.minor.patch`) of two version strings.
 *
 * A prerelease suffix is ignored, so `5.1.4-beta.1` compares EQUAL to `5.1.4`: a beta of the
 * release that satisfies a requirement is treated as satisfying it, which is what the beta
 * channel (`scripts/desktop-beta.sh` in the consumer) needs.
 *
 * ponytail: numeric core only, no full semver precedence. `semver` is a build-time dependency of
 * meteor-desktop and is NOT in `lib/skeletonDependencies.js`, so pulling it into the shipped app
 * for one comparison is not worth the bytes. Add prerelease ordering here if a bundle ever has to
 * require one specific prerelease.
 *
 * @param {String} a - Left version.
 * @param {String} b - Right version.
 *
 * @returns {Number} - Negative when a < b, zero when equal, positive when a > b.
 */
const compareCoreVersions = function (a, b) {
    const left = parseCoreVersion(a);
    const right = parseCoreVersion(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
};

export default {
    rimrafWithRetries,
    modernUserAgent,
    compareCoreVersions
};
