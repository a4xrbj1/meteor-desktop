import { rimraf } from 'rimraf';

/**
 * Simple wrapper for rimraf with additional retries in case of failure.
 * It is useful when something is concurrently reading the dir you want to remove.
 */
function rimrafWithRetries(path, optionsOrFs) {
    let options = {};
    if (optionsOrFs && optionsOrFs.unlinkSync) {
        options = { fs: optionsOrFs };
    } else if (optionsOrFs) {
        options = optionsOrFs;
    }
    let retries = 0;
    return new Promise((resolve, reject) => {
        function rm() {
            try {
                rimraf.sync(path, options);
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
