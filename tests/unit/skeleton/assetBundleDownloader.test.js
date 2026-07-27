import * as chai from 'chai';
import dirty from 'dirty-chai';
import crypto from 'crypto';
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

describe('AssetBundleDownloader#verifyResponse (sri integrity)', () => {
    before(() => {
        AssetBundleDownloader = require('../../../skeleton/modules/autoupdate/assetBundleDownloader.js').default;
    });

    const body = Buffer.from('console.log("hot code push");');
    const sri = crypto.createHash('sha512').update(body).digest('base64');
    // No ETag, so the legacy hash-vs-ETag branch is skipped; we exercise sri only.
    const response = { status: 200, headers: { get: () => null } };

    // seed meteor-desktop-1820: verify the downloaded bytes against the
    // manifest's sha512 sri digest.
    it('accepts a body whose sha512 matches the manifest sri', () => {
        expect(() => makeDownloader()
            .verifyResponse(response, { filePath: 'a.js', hash: null, sri }, body)).to.not.throw();
    });

    // Inversion (Rule 41): a tampered body must be rejected.
    it('rejects a body whose sha512 does not match the manifest sri', () => {
        expect(() => makeDownloader()
            .verifyResponse(response, { filePath: 'a.js', hash: null, sri }, Buffer.from('tampered')))
            .to.throw(/sri mismatch/);
    });

    // Legacy manifests (and index.html / source maps) carry no sri — skip, don't throw.
    it('skips sri verification when the asset has no sri', () => {
        expect(() => makeDownloader()
            .verifyResponse(response, { filePath: 'a.js', hash: null, sri: null }, body)).to.not.throw();
    });
});

describe('AssetBundleDownloader request headers', () => {
    before(() => {
        AssetBundleDownloader = require('../../../skeleton/modules/autoupdate/assetBundleDownloader.js').default;
    });

    // seed frontend-7c13: Meteor picks the client arch from the User-Agent, and the manifest
    // is always fetched from the modern /__browser/ endpoint. A request without a modern UA
    // gets web.browser.legacy bytes, which can never match the modern manifest's sri.
    it('sends a modern Chrome User-Agent with every asset request', async () => {
        const downloader = makeDownloader();
        downloader.missingAssets = [{ filePath: 'packages/modules.js', urlPath: '/packages/modules.js' }];
        const requests = [];
        downloader.httpClient = (requestUrl, options) => {
            requests.push(options);
            return Promise.reject(new Error('stop after capturing the request'));
        };

        downloader.resume();
        await new Promise((resolve) => {
            setTimeout(resolve, 10);
        });

        expect(requests).to.have.lengthOf(1);
        expect(requests[0].headers['User-Agent']).to.match(/ Chrome\/\d[\d.]* /);
        expect(requests[0].headers.Connection).to.equal('close');
    });
});
