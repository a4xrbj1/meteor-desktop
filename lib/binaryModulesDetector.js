import path from 'path';
import fs from 'fs';

import Log from './log.js';
/**
 * Experimental module for detecting modules containing binary files.
 * Based on the same functionality from electron-builder.
 *
 * @property {MeteorDesktop} $
 * @class
 */
export default class BinaryModulesDetector {
    /**
     * @constructor
     */
    constructor(nodeModulesPath) {
        this.log = new Log('binaryModulesDetector');
        this.nodeModulesPath = nodeModulesPath;
    }

    // TODO: make asynchronous
    detect() {
        this.log.verbose('detecting node modules with binary files');
        const files = fs.readdirSync(this.nodeModulesPath, { withFileTypes: true, recursive: true })
            .map((dirent) => {
                const abs = path.join(dirent.parentPath, dirent.name);
                const rel = path.relative(this.nodeModulesPath, abs).replace(/\\/g, '/');
                return { name: rel, isFile: () => dirent.isFile() };
            });

        const extract = [];

        files.forEach((file) => {
            const pathSplit = file.name.split(path.posix.sep);
            const dir = pathSplit[0];
            const filename = pathSplit.pop();

            if (extract.indexOf(dir) === -1
                && !BinaryModulesDetector.shouldBeIgnored(dir, filename)
            ) {
                if (file.isFile()) {
                    let shouldUnpack = false;
                    if (file.name.endsWith('.dll') || file.name.endsWith('.exe') || file.name.endsWith('.dylib') || file.name.endsWith('.node')) {
                        shouldUnpack = true;
                    }
                    if (shouldUnpack) {
                        this.log.debug(`binary file: ${file.name}`);
                        extract.push(dir);
                    }
                }
            }
        });
        if (extract.length > 0) {
            this.log.verbose(`detected modules to be extracted: ${extract.join(', ')}`);
        }
        return extract;
    }

    static shouldBeIgnored(dir, filename) {
        return dir === '.bin' || filename === '.DS_Store' || filename === 'LICENSE' || filename === 'README';
    }
}
