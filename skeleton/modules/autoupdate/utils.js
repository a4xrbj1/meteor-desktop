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

export default {
    rimrafWithRetries
};
