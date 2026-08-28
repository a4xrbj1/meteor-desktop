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
