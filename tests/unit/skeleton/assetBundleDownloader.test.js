import * as chai from 'chai';
import dirty from 'dirty-chai';
import { createRequire } from 'module';

chai.use(dirty);

const {
    describe, it, before
} = global;
const { expect } = chai;
const require = createRequire(import.meta.url);

let AssetBundleDownloader;

// Minimal logger satisfying log.getLoggerFor().{debug,verbose,info,warn,error}.
const noop = () => {};
const fakeLogger = {
    getLoggerFor() {
        return {
            debug: noop, verbose: noop, info: noop, warn: noop, error: noop
        };
    }
};

const EXPECTED = '7e3c01861258dc5e1e657b1bca4746e9f9b19c55';

// Builds a downloader whose assetBundle reports EXPECTED as the version being
// verified, and whose previous-config rootUrl/appId match the runtime config.
const makeDownloader = (version = EXPECTED) => new AssetBundleDownloader(
    fakeLogger,
    { rootUrlString: 'https://app.example.com/', appId: 'pzkp2619zyzxgsarhim' },
    { directoryUri: '/tmp/bundle', getVersion: () => version },
    'https://app.example.com/',
    []
);

const baseRuntimeConfig = (extra) => ({
    ROOT_URL: 'https://app.example.com/',
    appId: 'pzkp2619zyzxgsarhim',
    ...extra
});

describe('AssetBundleDownloader#verifyRuntimeConfig', () => {
    before(() => {
        AssetBundleDownloader = require('../../../skeleton/modules/autoupdate/assetBundleDownloader.js').default;
    });

    // G2 (seed meteor-desktop-e490): Meteor 3.x web.browser leaves the legacy
    // top-level autoupdateVersion(Cordova) fields null, but publishes the real
    // version under autoupdate.versions['web.browser'].version.
    it('accepts the per-arch version when the legacy top-level fields are null', () => {
        const runtimeConfig = baseRuntimeConfig({
            autoupdateVersionCordova: null,
            autoupdateVersion: null,
            autoupdate: { versions: { 'web.browser': { version: EXPECTED } } }
        });
        expect(() => makeDownloader().verifyRuntimeConfig(runtimeConfig)).to.not.throw();
    });

    // Inversion (Rule 41): the per-arch fallback must NOT weaken the coherence
    // gate — a mismatching per-arch version is still rejected.
    it('rejects a per-arch version that does not match the manifest version', () => {
        const runtimeConfig = baseRuntimeConfig({
            autoupdateVersionCordova: null,
            autoupdateVersion: null,
            autoupdate: { versions: { 'web.browser': { version: 'a_different_version' } } }
        });
        expect(() => makeDownloader().verifyRuntimeConfig(runtimeConfig))
            .to.throw(/version mismatch/);
    });

    it('throws when no version is present in any of the three sources', () => {
        const runtimeConfig = baseRuntimeConfig({
            autoupdateVersionCordova: null,
            autoupdateVersion: null,
            autoupdate: { versions: { 'web.browser': {} } }
        });
        expect(() => makeDownloader().verifyRuntimeConfig(runtimeConfig))
            .to.throw(/cannot verify downloaded bundle version/);
    });

    // Back-compat: the legacy fields still take precedence when present.
    it('still accepts the legacy top-level autoupdateVersion (Meteor < 3.x shape)', () => {
        const runtimeConfig = baseRuntimeConfig({ autoupdateVersion: EXPECTED });
        expect(() => makeDownloader().verifyRuntimeConfig(runtimeConfig)).to.not.throw();
    });

    it('still accepts autoupdateVersionCordova (Cordova shape)', () => {
        const runtimeConfig = baseRuntimeConfig({ autoupdateVersionCordova: EXPECTED });
        expect(() => makeDownloader().verifyRuntimeConfig(runtimeConfig)).to.not.throw();
    });
});
