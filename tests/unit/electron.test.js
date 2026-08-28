import * as chai from 'chai';

import Electron from '../../lib/electron.js';

const { describe, it } = global;
const { expect } = chai;

describe('electron run', () => {
    it('reports a failed spawn and sets exit code 1 instead of crashing (seed meteor-desktop-86d2)', async () => {
        const missingBuildDir = '/tmp/meteor-desktop-86d2-no-such-build';
        const electron = new Electron({
            env: { options: {}, paths: { electronApp: { root: missingBuildDir } } }
        });
        /** @type {any} */ (electron).electron = { dependency: process.execPath };
        const logged = [];
        electron.log.error = (...args) => logged.push(args.join(' '));
        const originalExitCode = process.exitCode;

        electron.run();
        // cross-spawn reports a nonexistent cwd asynchronously, as an 'error' event, not a throw.
        await new Promise((resolve) => { setTimeout(resolve, 200); });

        const { exitCode } = process;
        process.exitCode = originalExitCode;
        expect(exitCode).to.equal(1);
        expect(logged.join('\n')).to.contain(missingBuildDir);
        expect(logged.join('\n')).to.contain('ENOENT');
    });
});
