import * as chai from 'chai';
import dirty from 'dirty-chai';
import { createRequire } from 'module';

chai.use(dirty);

const { describe, it, before } = global;
const { expect } = chai;
const require = createRequire(import.meta.url);

let AssetManifest;

const noop = () => {};
const fakeLogger = {
    getLoggerFor() {
        return {
            debug: noop, verbose: noop, info: noop, warn: noop, error: noop
        };
    }
};

/**
 * A logger whose sub-logger appends every warning to the supplied array.
 *
 * @param {Array<String>} warnings - Collector.
 *
 * @returns {Object} - Logger.
 */
const collectingLogger = (warnings) => ({
    getLoggerFor() {
        return {
            debug: noop,
            verbose: noop,
            info: noop,
            warn: (message) => warnings.push(message),
            error: noop
        };
    }
});

// Shape taken from the live production /__browser/manifest.json (Meteor 3.5.1), trimmed to the
// fields AssetManifest reads. Real shape, not an invented one: one client entry, format
// web-program-pre1, a top-level version, and a PUBLIC_SETTINGS object.
const manifestJson = (extra) => JSON.stringify({
    format: 'web-program-pre1',
    version: 'd2359d65e2658cb5bea56cfe604d3b01d1d93aae',
    manifest: [{
        path: 'app/app.js',
        url: '/app/app.js?hash=abc',
        type: 'js',
        where: 'client',
        cacheable: true,
        size: 123,
        hash: 'abc',
        sri: 'Zm9v'
    }],
    ...extra
});

describe('AssetManifest#version fallback origin', () => {
    // A build artifact on disk NEVER has a version: webapp attaches lazy version getters to
    // WebApp.clientPrograms[arch] and materialises them only when it serves
    // /__<arch>/manifest.json. So a bundled manifest hitting the fallback is normal and must not
    // warn — that warning fired on every startup and is how seed meteor-desktop-e490 came to
    // record a root cause that does not exist. A SERVED manifest with no version is abnormal and
    // still warns. Inversion: make both branches warn and the first test fails.
    const versionlessManifest = JSON.stringify({
        format: 'web-program-pre1',
        manifest: [{
            path: 'app/app.js', url: '/app/app.js', type: 'js', where: 'client', cacheable: true, size: 1
        }]
    });

    before(() => {
        AssetManifest = require('../../../skeleton/modules/autoupdate/assetManifest.js').default;
    });

    it('does not warn for a bundled manifest, and still derives a version', () => {
        const warnings = [];
        const manifest = new AssetManifest(collectingLogger(warnings), versionlessManifest, 'bundled');
        expect(warnings).to.deep.equal([]);
        expect(manifest.version).to.match(/^[0-9a-f]{40}$/);
    });

    it('warns for a served manifest with no version', () => {
        const warnings = [];
        const manifest = new AssetManifest(collectingLogger(warnings), versionlessManifest, 'served');
        expect(warnings.join('\n')).to.include('has no version field');
        expect(manifest.version).to.match(/^[0-9a-f]{40}$/);
    });

    // The default has to be the loud one, so a call site that forgets to declare its origin keeps
    // the warning rather than silently losing it.
    it('defaults to the served (warning) behaviour', () => {
        const warnings = [];
        const manifest = new AssetManifest(collectingLogger(warnings), versionlessManifest);
        expect(manifest.version).to.match(/^[0-9a-f]{40}$/);
        expect(warnings.join('\n')).to.include('has no version field');
    });

    it('derives the same version regardless of origin', () => {
        const a = new AssetManifest(collectingLogger([]), versionlessManifest, 'bundled');
        const b = new AssetManifest(collectingLogger([]), versionlessManifest, 'served');
        expect(a.version).to.equal(b.version);
    });
});

describe('AssetManifest#minDesktopVersion', () => {
    before(() => {
        AssetManifest = require('../../../skeleton/modules/autoupdate/assetManifest.js').default;
    });

    it('is null when the manifest declares no minimum', () => {
        const manifest = new AssetManifest(fakeLogger, manifestJson());
        expect(manifest.minDesktopVersion).to.equal(null);
        // The rest of the manifest still parses — the new field cannot break existing bundles.
        expect(manifest.version).to.equal('d2359d65e2658cb5bea56cfe604d3b01d1d93aae');
        expect(manifest.entries).to.have.lengthOf(1);
    });

    it('reads a top-level minDesktopVersion', () => {
        const manifest = new AssetManifest(fakeLogger, manifestJson({ minDesktopVersion: '5.4.0' }));
        expect(manifest.minDesktopVersion).to.equal('5.4.0');
    });

    it('reads PUBLIC_SETTINGS.minDesktopVersion, which is what an app can publish today', () => {
        const manifest = new AssetManifest(
            fakeLogger,
            manifestJson({ PUBLIC_SETTINGS: { workerHost: 'https://back.example.com', minDesktopVersion: '5.4.0' } })
        );
        expect(manifest.minDesktopVersion).to.equal('5.4.0');
    });

    it('prefers the top-level field over PUBLIC_SETTINGS', () => {
        const manifest = new AssetManifest(fakeLogger, manifestJson({
            minDesktopVersion: '6.0.0',
            PUBLIC_SETTINGS: { minDesktopVersion: '5.4.0' }
        }));
        expect(manifest.minDesktopVersion).to.equal('6.0.0');
    });

    it('is null when PUBLIC_SETTINGS exists but carries no minimum', () => {
        const manifest = new AssetManifest(
            fakeLogger,
            manifestJson({ PUBLIC_SETTINGS: { workerHost: 'https://back.example.com' } })
        );
        expect(manifest.minDesktopVersion).to.equal(null);
    });
});
