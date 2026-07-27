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

export default {
    rimrafWithRetries,
    modernUserAgent
};
