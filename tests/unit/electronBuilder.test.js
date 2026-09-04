import fs from 'fs';
import os from 'os';
import path from 'path';

import * as chai from 'chai';

import InstallerBuilder from '../../lib/electronBuilder.js';
import meteorDesktop from '../../lib/index.js';

const { describe, it, after } = global;

// Every builderThatFails() call mkdtemps a root; without this they accumulate one per test per run
// (an adversarial review counted 50 already lying in the tmp root). Torn down at the end rather than
// per test so a failing assertion still leaves its directory to look at.
const tempRoots = [];

after(() => {
    tempRoots.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});
const { expect } = chai;

/**
 * Builds an InstallerBuilder wired to a stub electron-builder that fails the way the real one did on
 * the 2026-08-30 signed Windows run: it rejects out of `build()` having produced no artifacts.
 * Nothing is stubbed here that the harness could run for real - electron-builder is third-party, and
 * that failure needs a Parallels VM and an Azure signing identity to reproduce.
 *
 * @param {Error|null} failWith - the rejection to make electron-builder produce, or null to succeed
 * @param {Boolean} failCleanup - make the post-build extractedNodeModules removal throw
 *
 * @returns {InstallerBuilder}
 */
const builderThatFails = function (failWith, failCleanup = false) {
    // A real directory per call, because the node_modules restore is exercised against the real fs
    // rather than a stub - fs is stdlib, and a renameSync that actually moves a directory is the
    // behaviour under test.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-eb-'));
    tempRoots.push(root);
    const $ = {
        env: {
            options: { output: root, mac: true },
            paths: {
                installerDir: 'installer',
                electronApp: {
                    root: path.join(root, 'app'),
                    extractedNodeModules: path.join(root, 'extracted'),
                    nodeModules: path.join(root, 'app', 'node_modules'),
                    tmpNodeModules: path.join(root, 'tmp_node_modules')
                }
            },
            os: {}
        },
        desktop: { getSettings: () => ({ builderOptions: {} }) },
        getElectronVersion: () => '42.5.2',
        // The throw is injected at the `exists` probe rather than at the rmSync below it. Both sit
        // in the same try, so the property under test is identical - and a GENUINE rmSync failure is
        // not portably provokable: `force: true` swallows ENOENT and ENOTDIR alike (measured), so
        // the only real trigger is a permissions setup that a root test runner would defeat.
        utils: {
            exists: () => {
                if (failCleanup) {
                    throw new Error('EBUSY: resource busy or locked');
                }
                return false;
            }
        }
    };
    const instance = new InstallerBuilder(/** @type {any} */ ($));
    /** @type {any} */ (instance).builder = {
        dependency: {
            Platform: { WINDOWS: 'win', LINUX: 'linux', MAC: 'mac' },
            createTargets: () => new Map(),
            build: async () => {
                if (failWith) {
                    throw failWith;
                }
            }
        }
    };
    return instance;
};

describe('electronBuilder build', () => {
    // The whole of seed frontend-4e42. electron-builder aborted with an InvalidConfigurationError,
    // build() caught it, logged it and resolved - so buildInstaller()'s `throwError` rethrow (added
    // for seed meteor-desktop-a8f8) never saw an error, the CLI's .catch never fired, and a build
    // that produced no installer at all told the shell it had succeeded. desktop-beta.sh runs under
    // `set -e` and walked straight past it. Inversion: put a `catch (e) { this.log.error(...); }`
    // back around the electron-builder call and this fails - the promise resolves.
    it('rejects when electron-builder fails, instead of logging and resolving', async () => {
        const failure = new Error('Cannot find suitable Parallels Desktop virtual machine');
        let rejectedWith = null;
        try {
            await builderThatFails(failure).build();
        } catch (e) {
            rejectedWith = e;
        }
        expect(rejectedWith, 'build() swallowed the electron-builder failure').to.equal(failure);
    });

    it('still resolves when electron-builder succeeds', async () => {
        await builderThatFails(null).build();
    });

    // The other half of removing that catch, and the half the first version of this fix got wrong:
    // the same catch also covered the temp-dir cleanup that runs AFTER a successful build. Widening
    // failure to cover it would report a perfectly good installer as a failed build every time the
    // rmSync lost a race with a Windows file lock. Inversion: take the cleanup's own try/catch away
    // and this fails.
    it('does not fail a successful build when the temp-dir cleanup throws', async () => {
        await builderThatFails(null, true).build();
    });

    // Seed meteor-desktop-701d. beforeBuild moves the app's node_modules out to tmpNodeModules and
    // the rename back lives only in afterPack, which a failed electron-builder run never reaches -
    // observed on the 2026-08-30 signed --mac --win beta run, which died in
    // WindowsSignAzureManager.initialize and left .meteor/.desktop_node_modules/ behind. Inversion:
    // remove the finally in build() and the restored assertion fails with the modules still in tmp.
    it('moves node_modules back when electron-builder fails', async () => {
        const instance = builderThatFails(new Error('WindowsSignAzureManager: no identity'));
        const paths = /** @type {any} */ (instance).$.env.paths.electronApp;

        // The app root exists in a real failed build - electron-builder was pointed at it as
        // directories.app and the scaffold created it - so the restore has somewhere to land.
        fs.mkdirSync(paths.root, { recursive: true });
        fs.mkdirSync(paths.tmpNodeModules, { recursive: true });
        fs.writeFileSync(path.join(paths.tmpNodeModules, 'marker'), 'x');
        /** @type {any} */ (instance).nodeModulesMovedOut = true;

        let rejectedWith = null;
        try {
            await instance.build();
        } catch (e) {
            rejectedWith = e;
        }

        expect(rejectedWith, 'the finally swallowed the build failure').to.be.an('error');
        expect(fs.existsSync(path.join(paths.nodeModules, 'marker')), 'node_modules was not restored')
            .to.equal(true);
        expect(fs.existsSync(paths.tmpNodeModules), 'the modules were left stranded in tmpNodeModules')
            .to.equal(false);
    });

    // The other half of seed meteor-desktop-701d, and a regression this fix ITSELF introduced before
    // an adversarial review reproduced it. moveNodeModulesOut() used to be a
    // `.catch(e => reject(e)).then(next)` chain, and rejecting the outer promise does NOT stop the
    // inner chain - so after ANY failure every later step still ran, including the delayed
    // `removeDir(nodeModules, 1000)`. With the restore added, the sequence became: move-out fails,
    // build() aborts, the finally puts node_modules back, and a second later that pending removeDir
    // deletes it. Stranded-but-recoverable turned into deleted.
    //
    // Provoked with a real failure and no stubbing: tmpNodeModules is given a parent that does not
    // exist, so renameSync throws ENOENT while node_modules is still sitting there populated. The
    // reviewer's own repro drove it through a rejecting wait() instead, which is the same mechanism
    // one step later but costs 24s here because the real wait() retries six times at 4s.
    // Inversion: restore the promise chain and this fails - the marker is gone after the delay.
    it('does not schedule a delayed delete of node_modules after a failed move-out', async () => {
        const instance = builderThatFails(null);
        const paths = /** @type {any} */ (instance).$.env.paths.electronApp;
        paths.tmpNodeModules = path.join(paths.root, 'no-such-parent', 'tmp_node_modules');

        fs.mkdirSync(paths.nodeModules, { recursive: true });
        fs.writeFileSync(path.join(paths.nodeModules, 'marker'), 'x');
        /** @type {any} */ (instance).currentContext = { platform: { nodeName: 'darwin' } };

        let rejected = false;
        try {
            await instance.moveNodeModulesOut();
        } catch {
            rejected = true;
        }

        expect(rejected, 'the move-out should have failed on the missing parent').to.equal(true);
        expect(/** @type {any} */ (instance).nodeModulesMovedOut, 'nothing was moved, so the flag must stay false')
            .to.equal(false);

        // Outlive the removeDir(nodeModules, 1000) that the old chain would have scheduled.
        await new Promise((resolve) => { setTimeout(resolve, 1300); });

        expect(fs.existsSync(path.join(paths.nodeModules, 'marker')), 'node_modules was deleted by a pending cleanup')
            .to.equal(true);
    });

    // The restore must not invent a move that never happened. Its other caller is afterPack, which
    // REJECTS on a throw rather than swallowing it, and which runs on the success path where the
    // flag has already been cleared by the restore that just succeeded - so an unconditional
    // renameSync would fail a build that worked, with an ENOENT on a tmp dir that is correctly
    // absent. Inversion: delete the `if (!this.nodeModulesMovedOut) return false` guard and this
    // throws instead of returning false.
    it('is a no-op, not a throw, when nothing was moved out', () => {
        const instance = builderThatFails(null);

        expect(instance.restoreNodeModules()).to.equal(false);
    });
});

describe('index buildInstaller', () => {
    // The error the operator reads must be the one electron-builder threw. This rethrow used to be
    // `throw new Error(e)`, which stringifies the original into a new message and generates a fresh
    // stack here, discarding the one that points at the real cause. It did not matter while the
    // catch was unreachable; it is the only stack now that it is the normal path. Inversion: put
    // `throw new Error(e)` back and the identity assertion fails.
    it('rethrows the original error object, not a re-wrapped copy', async () => {
        const failure = new Error('Cannot find suitable Parallels Desktop virtual machine');
        const md = meteorDesktop(
            '/tmp/sample-app',
            '/tmp/sample-app',
            { skipMobileBuild: true, output: '/tmp/sample-app' }
        );
        /** @type {any} */ (md).electronApp = { build: async () => {} };
        /** @type {any} */ (md).electronBuilder = { build: async () => { throw failure; } };

        let rejectedWith = null;
        try {
            await md.buildInstaller(true);
        } catch (e) {
            rejectedWith = e;
        }
        expect(rejectedWith).to.equal(failure);
    });

    // The default stays as it was: a caller that did not ask to be told still is not.
    it('resolves without throwError, so existing callers are unaffected', async () => {
        const md = meteorDesktop(
            '/tmp/sample-app',
            '/tmp/sample-app',
            { skipMobileBuild: true, output: '/tmp/sample-app' }
        );
        /** @type {any} */ (md).electronApp = { build: async () => {} };
        /** @type {any} */ (md).electronBuilder = { build: async () => { throw new Error('nope'); } };

        await md.buildInstaller();
    });
});
