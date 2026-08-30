import * as chai from 'chai';

import InstallerBuilder from '../../lib/electronBuilder.js';
import meteorDesktop from '../../lib/index.js';

const { describe, it } = global;
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
    const $ = {
        env: {
            options: { output: '/tmp/md-eb', mac: true },
            paths: {
                installerDir: 'installer',
                electronApp: { root: '/tmp/md-eb/app', extractedNodeModules: '/tmp/md-eb/extracted' }
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
