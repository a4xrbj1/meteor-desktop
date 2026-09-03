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

describe('AssetBundleDownloader byte progress', () => {
    before(() => {
        AssetBundleDownloader = require('../../../skeleton/modules/autoupdate/assetBundleDownloader.js').default;
    });

    // Builds a downloader over a given missingAssets array. The total is summed in the
    // CONSTRUCTOR (missingAssets is spliced as assets land), so constructing is the whole test.
    const withAssets = (missingAssets) => new AssetBundleDownloader(
        fakeLogger,
        { rootUrlString: 'https://app.example.com/', appId: 'pzkp2619zyzxgsarhim' },
        { directoryUri: '/tmp/bundle', getVersion: () => EXPECTED },
        'https://app.example.com/',
        missingAssets
    );

    // REGRESSION, seed frontend-dac7. The 6.0.28 progress feature summed `asset.size`, but
    // missingAssets holds Asset objects (assetBundle.js:22) whose size lives on `entrySize` —
    // `size` is the name on the raw MANIFEST entry, one hop earlier, in assetManifest.js. Every
    // asset therefore contributed `undefined || 0` and the shell reported "0 of 0 bytes" for the
    // entire download. Observed end-to-end: a real HCP download drove appUpdateTotal 0 and
    // appUpdateTransferred 0 from start to finish. Inversion: change `entrySize` back to `size`
    // in assetBundleDownloader.js and this expectation drops to 0.
    it('sums bytesTotal from the Asset field that actually carries the size', () => {
        const downloader = withAssets([
            { filePath: 'a.js', entrySize: 1000 },
            { filePath: 'b.js', entrySize: 2000 }
        ]);
        expect(downloader.bytesTotal).to.equal(3000);
        expect(downloader.bytesTransferred).to.equal(0);
    });

    // Pins the field name from the other side: an object shaped like a raw manifest entry must
    // NOT contribute, because that is not what missingAssets contains. Without this, someone
    // "simplifying" back to `asset.size` could make the test above pass by changing its fixture.
    it('ignores a raw manifest-entry shape, which is not what missingAssets holds', () => {
        expect(withAssets([{ filePath: 'a.js', size: 1000 }]).bytesTotal).to.equal(0);
    });

    // Index.html and source maps have no size in some manifests; they must not poison the sum.
    it('tolerates assets with no size rather than producing NaN', () => {
        const downloader = withAssets([{ filePath: 'index.html' }, { filePath: 'a.js', entrySize: 500 }]);
        expect(downloader.bytesTotal).to.equal(500);
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
        // seed meteor-desktop-4d13: this used to assert Connection: close. A close-delimited
        // response leaves undici's parser with shouldKeepAlive false, which is the sole gate on
        // its three `parser.finish()` call sites — and finish() asserts !paused, while the parser
        // IS paused on body backpressure. A socket dying mid-asset then throws an AssertionError
        // out of the socket's 'error' listener, past every .catch, and crashes the main process.
        expect(requests[0].headers).to.not.have.property('Connection');
    });
});

describe('AssetBundleDownloader download concurrency', () => {
    before(() => {
        AssetBundleDownloader = require('../../../skeleton/modules/autoupdate/assetBundleDownloader.js').default;
    });

    // seed meteor-desktop-3669. `new Queue()` defaults to concurrency Infinity, so resume() fired
    // EVERY missing asset at once — 285 simultaneous requests for the yourdna.family bundle. Measured
    // against production 2026-08-18: sequential, 20-way and 80-way were 100% 200, while the third
    // consecutive 151-way burst returned 48x 503. One shed asset calls didFail, which cancels the
    // whole download, and the app then silently stays on its baked bundle.
    //
    // The stub returns a promise that NEVER settles, deliberately: a rejection would reach didFail
    // and end the queue, so the cap could never be observed. Holding every slot open is what makes
    // the ceiling measurable. The cap is reached synchronously inside resume(), so the wait below is
    // only there to let any deferred start land — nothing about the assertion is timing-dependent.
    // Inversion: restore `new Queue()` and maxInFlight becomes 40.
    it('never has more than the configured number of asset requests in flight', async () => {
        const downloader = makeDownloader();
        downloader.missingAssets = Array.from({ length: 40 }, (asset, index) => ({
            filePath: `a${index}.js`, urlPath: `/a${index}.js`
        }));
        let inFlight = 0;
        let maxInFlight = 0;
        downloader.httpClient = () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return new Promise(() => {});
        };

        downloader.resume();
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });

        expect(maxInFlight).to.equal(6);
        expect(downloader.missingAssets).to.have.lengthOf(40);
    });
});
