import * as chai from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Electron from '../../lib/electron.js';

const { describe, it, afterEach } = global;
const { expect } = chai;

const SENTINEL = 99;

/**
 * Builds an Electron runner whose "electron" is a real node process running a one-line app, so the
 * child genuinely exits the way the test asks. `run()` spawns `dependency` with `.` as the argument
 * in the app root, and `node .` resolves index.js there.
 *
 * @param {String} body - Body of the index.js the child will run.
 *
 * @returns {Object} - { electron, logged, root }
 */
const electronRunning = (body) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-a8f8-'));
    fs.writeFileSync(path.join(root, 'index.js'), body);
    const electron = new Electron({
        env: { options: {}, paths: { electronApp: { root } } }
    });
    /** @type {any} */ (electron).electron = { dependency: process.execPath };
    const logged = [];
    electron.log.error = (...args) => logged.push(args.join(' '));
    return { electron, logged, root };
};

/**
 * Runs the child and resolves once the exit handler has actually set an outcome.
 *
 * Polls for process.exitCode to move off a sentinel rather than sleeping a fixed interval: a fixed
 * sleep either flakes on a loaded machine or wastes the difference on every run, and it would let
 * the assertions read a stale exitCode while claiming to have waited for the handler.
 *
 * @param {Object} electron - Electron runner from electronRunning.
 *
 * @returns {Promise<void>}
 */
const runToExit = (electron) => new Promise((resolve, reject) => {
    // A value no test expects, so "changed" is unambiguous even when the child exits 0.
    process.exitCode = SENTINEL;
    const deadline = Date.now() + 8000;
    electron.run();
    const tick = () => {
        if (process.exitCode !== SENTINEL) {
            resolve();
        } else if (Date.now() > deadline) {
            reject(new Error('electron exit handler never set an exit code'));
        } else {
            setTimeout(tick, 10);
        }
    };
    tick();
});

describe('electron run', () => {
    let previousExitCode;

    afterEach(() => {
        process.exitCode = previousExitCode;
    });

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

    // Without this the CLI exits 0 whether the desktop app quit cleanly or crashed, which is
    // exactly the scripted smoke-launch case just-run exists for (seed meteor-desktop-a8f8).
    // Inversion: delete the child.on('exit') handler and this sees the ambient 0.
    it('forwards a non-zero exit code from the desktop app', async () => {
        previousExitCode = process.exitCode;
        const { electron, logged } = electronRunning('process.exit(3);');

        await runToExit(electron);

        expect(process.exitCode).to.equal(3);
        expect(logged.join('\n')).to.contain('exited with code 3');
    });

    it('forwards a clean exit as 0 and says nothing about it', async () => {
        previousExitCode = process.exitCode;
        const { electron, logged } = electronRunning('process.exit(0);');

        await runToExit(electron);

        expect(process.exitCode).to.equal(0);
        expect(logged).to.have.lengthOf(0);
    });

    // A signal kill carries no exit code to forward, and a launch that had to be killed is not a
    // successful one — so it must not fall through as a silent 0.
    it('reports a signal termination as a failure rather than a silent success', async () => {
        previousExitCode = process.exitCode;
        const { electron, logged } = electronRunning(
            'process.kill(process.pid, "SIGTERM");setTimeout(function(){},1000);'
        );

        await runToExit(electron);

        expect(process.exitCode).to.equal(1);
        expect(logged.join('\n')).to.contain('SIGTERM');
    });
});
