import * as chai from 'chai';
import dirty from 'dirty-chai';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

chai.use(dirty);

const {
    describe, it, before, beforeEach, afterEach
} = global;
const { expect } = chai;
const require = createRequire(import.meta.url);

let AssetBundle;
let AssetBundleManager;
let AssetManifest;

const noop = () => {};
// Self-returning: AssetBundle takes a sub-logger from getLoggerFor and hands it to AssetManifest,
// which calls getLoggerFor again — so every level of the real chain has to answer it.
const fakeLogger = {
    debug: noop,
    verbose: noop,
    info: noop,
    warn: noop,
    error: noop,
    getLoggerFor() {
        return fakeLogger;
    }
};

const manifestSource = (version, assetCount) => JSON.stringify({
    format: 'web-program-pre1',
    version,
    manifest: Array.from({ length: assetCount }, (unused, i) => ({
        path: `app/app${i}.js`,
        url: `/app/app${i}.js`,
        type: 'js',
        where: 'client',
        cacheable: true,
        size: 4
    }))
});

/**
 * Lays down a real bundle directory on disk — program.json plus index.html — so AssetBundle and
 * AssetBundleManager run against real files rather than stand-ins.
 *
 * @param {String} dir     - Directory to create.
 * @param {String} version - Bundle version.
 * @param {Number} assets  - How many client assets the manifest lists.
 *
 * @returns {String} - The directory.
 */
const writeBundleDir = (dir, version, assets) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'program.json'), manifestSource(version, assets));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    return dir;
};

describe('AssetBundleManager', () => {
    let root;
    let versionsDir;
    let server;
    let baseUrl;
    let requests;

    before(() => {
        AssetBundle = require('../../../skeleton/modules/autoupdate/assetBundle.js').default;
        AssetBundleManager = require('../../../skeleton/modules/autoupdate/assetBundleManager.js').default;
        AssetManifest = require('../../../skeleton/modules/autoupdate/assetManifest.js').default;
    });

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-abm-'));
        versionsDir = path.join(root, 'versions');
        fs.mkdirSync(versionsDir);
        requests = [];
    });

    afterEach((done) => {
        fs.rmSync(root, { recursive: true, force: true });
        if (!server) {
            done();
            return;
        }
        const toClose = server;
        server = null;
        toClose.closeAllConnections();
        toClose.close(() => done());
    });

    /**
     * Starts a real HTTP server whose responses are delayed, which is what a stalled download
     * actually looks like on the wire. `delay: null` means "accept the request and never answer".
     *
     * @param {Number|null} delay - Milliseconds to wait before responding, or null to hang.
     *
     * @returns {Promise<void>}
     */
    const startServer = (delay) => new Promise((resolve) => {
        server = http.createServer((req, res) => {
            requests.push(req.url);
            if (delay === null) {
                return;
            }
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/javascript' });
                res.end('void');
            }, delay);
        });
        server.listen(0, '127.0.0.1', () => {
            baseUrl = `http://127.0.0.1:${server.address().port}/`;
            resolve();
        });
    });

    /**
     * Builds a real AssetBundleManager over the temp versions dir, plus a real AssetBundle for the
     * bundle it is about to download.
     *
     * @param {Object} appSettings - Desktop settings.json stand-in (the timeout knobs live here).
     * @param {Number} assets      - How many assets the downloaded bundle lists.
     *
     * @returns {Object} - { manager, downloadBundle, events }
     */
    const build = (appSettings, assets = 2) => {
        const initialBundle = new AssetBundle(
            fakeLogger,
            writeBundleDir(path.join(root, 'initial'), 'initialversion', 1)
        );
        const manager = new AssetBundleManager(
            fakeLogger, { appId: 'appid', rootUrlString: baseUrl }, initialBundle, versionsDir, appSettings
        );

        const downloadDir = writeBundleDir(path.join(versionsDir, 'Downloading'), 'newversion', assets);
        const manifest = new AssetManifest(fakeLogger, manifestSource('newversion', assets));
        const downloadBundle = new AssetBundle(fakeLogger, downloadDir, manifest, initialBundle);

        const events = [];
        manager.setCallback({
            onError: (cause) => events.push(['error', String(cause)]),
            onDownloadStarted: (bytesTotal) => events.push(['started', bytesTotal]),
            onDownloadProgress: () => events.push(['progress']),
            onFinishedDownloadingAssetBundle: () => events.push(['finished'])
        });
        return { manager, downloadBundle, events };
    };

    const waitFor = (predicate, timeout = 4000) => new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (predicate()) {
                resolve();
            } else if (Date.now() - started > timeout) {
                reject(new Error('timed out waiting for condition'));
            } else {
                setTimeout(tick, 10);
            }
        };
        tick();
    });

    describe('#resolveTimeout', () => {
        it('falls back to the default when the setting is absent or unusable', () => {
            const initialBundle = new AssetBundle(
                fakeLogger, writeBundleDir(path.join(root, 'initial'), 'v', 1)
            );
            const manager = new AssetBundleManager(fakeLogger, {}, initialBundle, versionsDir, {
                hcpStallTimeout: 0, hcpRequestTimeout: 'soon'
            });
            expect(manager.resolveTimeout('hcpStallTimeout', 300000)).to.equal(300000);
            expect(manager.resolveTimeout('hcpRequestTimeout', 30000)).to.equal(30000);
            expect(manager.resolveTimeout('nothingLikeThis', 1234)).to.equal(1234);
        });

        it('honours a configured value', () => {
            const initialBundle = new AssetBundle(
                fakeLogger, writeBundleDir(path.join(root, 'initial'), 'v', 1)
            );
            const manager = new AssetBundleManager(
                fakeLogger, {}, initialBundle, versionsDir, { hcpStallTimeout: 777 }
            );
            expect(manager.resolveTimeout('hcpStallTimeout', 300000)).to.equal(777);
        });
    });

    describe('#checkForUpdates manifest timeout', () => {
        // Without the AbortSignal a server that accepts the connection and never answers wedges
        // HCP forever, emitting nothing at all. Inversion: drop `signal:` from the fetch options
        // and this test times out instead of passing.
        it('fails the check instead of hanging when the server never answers', async () => {
            await startServer(null);
            const { manager, events } = build({ hcpRequestTimeout: 200 });

            manager.checkForUpdates(baseUrl);

            await waitFor(() => events.some(([name]) => name === 'error'));
            const [, cause] = events.find(([name]) => name === 'error');
            expect(cause).to.include('error querying asset manifest');
            expect(requests).to.have.lengthOf(1);
        });

        // The other hang shape, and the one connect-hang does not cover: the server answers with
        // headers and then never sends a body. The abort has to reach the response body read, not
        // just the headers, or the check still wedges unboundedly.
        it('fails the check when the server sends headers and then no body', async () => {
            await new Promise((resolve) => {
                server = http.createServer((req, res) => {
                    requests.push(req.url);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.write('{');
                });
                server.listen(0, '127.0.0.1', () => {
                    baseUrl = `http://127.0.0.1:${server.address().port}/`;
                    resolve();
                });
            });
            const { manager, events } = build({ hcpRequestTimeout: 200 });

            manager.checkForUpdates(baseUrl);

            await waitFor(() => events.some(([name]) => name === 'error'));
            const [, cause] = events.find(([name]) => name === 'error');
            expect(cause).to.include('error querying asset manifest');
        });
    });

    describe('#downloadAssetBundle stall watchdog', () => {
        // The e490 production symptom: a download that emits nothing and never ends, leaving the
        // user on a dead progress bar until they restart. Inversion: delete the armStallTimer()
        // call before resume() and this test times out.
        it('gives up on a download where no asset ever completes', async () => {
            await startServer(null);
            const { manager, downloadBundle, events } = build({ hcpStallTimeout: 200 });

            manager.downloadAssetBundle(downloadBundle, baseUrl);

            await waitFor(() => events.some(([name]) => name === 'error'));
            const [, cause] = events.find(([name]) => name === 'error');
            expect(cause).to.include('stalled');
            expect(cause).to.include('no asset completed in 200ms');
            expect(events.some(([name]) => name === 'started')).to.be.true();
            expect(events.some(([name]) => name === 'finished')).to.be.false();
        });

        // The other half of the watchdog: responses that land after it fired must not resurrect
        // the download. Inversion: delete the `if (self.cancelInvoked) return;` guard at the top of
        // assetBundleDownloader's onResponse and 'finished' arrives after the error.
        it('does not report success from responses that land after it fired', async () => {
            await startServer(600);
            const { manager, downloadBundle, events } = build({ hcpStallTimeout: 150 });

            manager.downloadAssetBundle(downloadBundle, baseUrl);

            await waitFor(() => events.some(([name]) => name === 'error'));
            await new Promise((resolve) => { setTimeout(resolve, 900); });

            expect(events.filter(([name]) => name === 'finished')).to.have.lengthOf(0);
            expect(events.filter(([name]) => name === 'error')).to.have.lengthOf(1);
        });

        // The watchdog must not kill a download that is making progress. 30 assets at 80ms with the
        // downloader's concurrency of 6 is five waves, ~400ms — deliberately LONGER than the 300ms
        // window, so only the re-arm on each completed asset can carry it through, while each
        // individual wave has 220ms of slack so a loaded machine does not false-fire the test.
        // Inversion: delete armStallTimer() from the progress callback and this fails with a
        // stall error partway through the fourth wave.
        it('does not fire while assets keep completing', async () => {
            await startServer(80);
            const { manager, downloadBundle, events } = build({ hcpStallTimeout: 300 }, 30);

            manager.downloadAssetBundle(downloadBundle, baseUrl);

            await waitFor(() => events.some(([name]) => name === 'finished'));
            expect(events.some(([name]) => name === 'error')).to.be.false();
            // ...and the timer is disarmed on success: nothing fires after the bundle lands.
            await new Promise((resolve) => { setTimeout(resolve, 400); });
            expect(events.filter(([name]) => name === 'error')).to.have.lengthOf(0);
        });
    });
    /**
     * Writes a bundle directory whose manifest carries explicit entries, plus the real bytes of
     * every entry on disk — cache reuse turns on both the manifest fields and the file existing.
     *
     * @param {String} dir     - Directory to create.
     * @param {String} version - Bundle version.
     * @param {Array}  entries - Raw manifest entries.
     *
     * @returns {String} - The directory.
     */
    const writeBundleWithEntries = (dir, version, entries) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'program.json'),
            JSON.stringify({ format: 'web-program-pre1', version, manifest: entries })
        );
        fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
        entries.forEach((entry) => {
            const file = path.join(dir, entry.path);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `bytes of ${entry.path} from ${version}`);
        });
        return dir;
    };

    const entry = (overrides) => ({
        path: 'app/cached.js',
        url: '/app/cached.js',
        type: 'js',
        where: 'client',
        cacheable: true,
        hash: 'thehash',
        sri: 'thesri',
        size: 4,
        ...overrides
    });

    /**
     * Puts one already-downloaded bundle in versions/, then asks the manager to download a new
     * bundle that wants `wanted`. Whether the asset is copied from cache or fetched is then
     * visible in `requests`.
     *
     * @param {Object} cached - Manifest entry of the asset already on disk.
     * @param {Object} wanted - Manifest entry the new bundle asks for.
     *
     * @returns {Object} - { manager, downloadBundle, events }
     */
    const buildWithCachedBundle = (cached, wanted) => {
        writeBundleWithEntries(path.join(versionsDir, 'cachedversion'), 'cachedversion', [cached]);
        const initialBundle = new AssetBundle(
            fakeLogger, writeBundleDir(path.join(root, 'initial'), 'initialversion', 1)
        );
        const manager = new AssetBundleManager(
            fakeLogger, { appId: 'appid', rootUrlString: baseUrl }, initialBundle, versionsDir, {}
        );
        const downloadDir = writeBundleWithEntries(
            path.join(versionsDir, 'Downloading'), 'newversion', [wanted]
        );
        // The Downloading dir is written with its bytes already present so the directory is
        // realistic; remove the asset so a copy or a fetch is what actually puts it there.
        fs.rmSync(path.join(downloadDir, wanted.path));
        const manifest = new AssetManifest(
            fakeLogger,
            JSON.stringify({ format: 'web-program-pre1', version: 'newversion', manifest: [wanted] })
        );
        const downloadBundle = new AssetBundle(fakeLogger, downloadDir, manifest, initialBundle);
        const events = [];
        manager.setCallback({
            onError: (cause) => events.push(['error', String(cause)]),
            onDownloadStarted: () => events.push(['started']),
            onDownloadProgress: () => events.push(['progress']),
            onFinishedDownloadingAssetBundle: () => events.push(['finished'])
        });
        return {
            manager, downloadBundle, events, downloadDir
        };
    };

    // The download always fetches index.html ('/') as well, and asset urls carry
    // ?meteor_dont_serve_index=true — so "was it copied or fetched" is a prefix test on the asset's
    // own url, never a request count.
    const fetchedTheAsset = () => requests.some((u) => u.startsWith('/app/cached.js'));
    // The stub server answers every asset with the same body, so a re-downloaded asset legitimately
    // fails its sri check. Settling on either outcome is what these tests wait for; which one it is
    // says nothing about the cache decision, which `requests` already recorded.
    const settled = (events) => events.some(([n]) => n === 'finished' || n === 'error');

    describe('cached asset reuse (seed meteor-desktop-932b)', () => {
        // Before this, the partial/cached branch could not return anything at all: the guard was
        // `fs.accessSync(file)`, which returns undefined on success, so it was always falsy and
        // every retry re-downloaded the whole bundle. Inversion: put accessSync back, or make
        // canReuseCachedAsset return false, and this test sees a request and fails.
        it('copies an asset whose sri matches instead of downloading it', async () => {
            await startServer(0);
            const { manager, downloadBundle, events } = buildWithCachedBundle(
                entry({}), entry({})
            );

            manager.downloadAssetBundle(downloadBundle, baseUrl);

            await waitFor(() => events.some(([name]) => name === 'finished'));
            expect(fetchedTheAsset()).to.be.false();
            // index.html is still fetched, so the download succeeds and the bundle is moved out of
            // Downloading into versions/<version> — which is where the copied bytes end up.
            expect(fs.readFileSync(path.join(versionsDir, 'newversion', 'app/cached.js'), 'utf8'))
                .to.equal('bytes of app/cached.js from cachedversion');
        });

        // The hazard the seed was filed for. `hash` is not a content digest — verifyResponse says
        // so — so bytes from a different build can sit under the path this manifest wants. A
        // reused asset never passes verifyResponse, so sri is the only thing standing between the
        // app and running them. Inversion: drop the sri comparison and no request is made.
        it('re-downloads when the cached sri differs, however well the hash matches', async () => {
            await startServer(0);
            const { manager, downloadBundle, events } = buildWithCachedBundle(
                entry({ sri: 'sri-of-some-other-build' }), entry({})
            );

            manager.downloadAssetBundle(downloadBundle, baseUrl);

            await waitFor(() => settled(events));
            expect(fetchedTheAsset()).to.be.true();
        });

        // The urlPath-only match: cachedAssetForUrlPath returns a cacheable asset when the wanted
        // hash is null, without comparing anything about the bytes. That is the arch-mismatch
        // resurrection route the seed warns about, and with no sri and no hash there is nothing
        // left that could rule it out. Inversion: accept the urlPath-only match and no request is
        // made — the app runs whatever build's bytes were lying in that directory.
        it('re-downloads when neither sri nor hash identifies the asset', async () => {
            await startServer(0);
            const { manager, downloadBundle, events } = buildWithCachedBundle(
                entry({ hash: null, sri: null }), entry({ hash: null, sri: null })
            );

            manager.downloadAssetBundle(downloadBundle, baseUrl);

            await waitFor(() => settled(events));
            expect(fetchedTheAsset()).to.be.true();
        });

        /**
         * Puts a half-finished download in PartialDownload the way
         * moveExistingDownloadDirectoryIfNeeded does — which is the detail that matters: it renames
         * the Downloading directory wholesale, so the manifest sitting in there is the NEW one.
         *
         * @param {Object} rig     - Result of buildWithCachedBundle.
         * @param {Object} partial - Manifest entry to leave behind in the partial directory.
         *
         * @returns {void}
         */
        const withPartialDownload = (rig, partial) => {
            const dir = writeBundleWithEntries(
                path.join(versionsDir, 'PartialDownload'), 'newversion', [partial]
            );
            fs.writeFileSync(path.join(dir, partial.path), 'bytes left by the abandoned download');
            // eslint-disable-next-line no-param-reassign
            rig.manager.partiallyDownloadedAssetBundle = new AssetBundle(fakeLogger, dir);
        };

        // The bandwidth half of the seed: a resumed download should not refetch what the abandoned
        // one already got. This branch could never return anything before the existsSync fix, so
        // every retry paid for the whole bundle again.
        it('resumes from the partial download directory when sri vouches for the bytes', async () => {
            await startServer(0);
            // The complete bundle is deliberately made a non-candidate (different hash AND sri),
            // so the only thing that can answer is the partial directory.
            const rig = buildWithCachedBundle(
                entry({ hash: 'anotherhash', sri: 'unrelated' }), entry({})
            );
            withPartialDownload(rig, entry({}));

            rig.manager.downloadAssetBundle(rig.downloadBundle, baseUrl);

            await waitFor(() => settled(rig.events));
            expect(fetchedTheAsset()).to.be.false();
        });

        // ...and the correctness half, which is why the partial directory is held to a stricter
        // test than a complete bundle. Its program.json IS the new manifest, so comparing hashes
        // compares that manifest with itself and cannot fail whatever bytes are in the directory —
        // exactly how a pre-frontend-7c13 run's legacy bytes would be resurrected under a modern
        // manifest, from cache, with no verifyResponse in the path. Inversion: allow the hash match
        // here and no request is made.
        it('refuses a hash-only match from the partial download directory', async () => {
            await startServer(0);
            const rig = buildWithCachedBundle(
                entry({ hash: 'anotherhash', sri: 'unrelated' }), entry({ sri: null })
            );
            withPartialDownload(rig, entry({ sri: null }));

            rig.manager.downloadAssetBundle(rig.downloadBundle, baseUrl);

            await waitFor(() => settled(rig.events));
            expect(fetchedTheAsset()).to.be.true();
        });

        // sri agreeing is not enough on its own — the bytes have to actually be there. Inversion:
        // drop the existsSync and the copy throws ENOENT into didFail instead of downloading.
        it('re-downloads when the cached file is gone from disk', async () => {
            await startServer(0);
            const { manager, downloadBundle, events } = buildWithCachedBundle(
                entry({}), entry({})
            );
            fs.rmSync(path.join(versionsDir, 'cachedversion', 'app/cached.js'));

            manager.downloadAssetBundle(downloadBundle, baseUrl);

            await waitFor(() => settled(events));
            expect(fetchedTheAsset()).to.be.true();
            // Without the existsSync the copy is attempted anyway and dies on the missing source,
            // so the download never happens and the check fails outright.
            const errors = events.filter(([name]) => name === 'error').map(([, cause]) => cause);
            expect(errors.some((cause) => cause.includes('ENOENT'))).to.be.false();
        });
    });
    describe('overlapping downloads (seed meteor-desktop-912a)', () => {
        let servedVersion;
        let manifestStatus;

        /**
         * Serves a real manifest at the endpoint checkForUpdates actually asks for, and hangs on
         * every asset so the download stays in flight while a second check is made. The served
         * version is mutable so one server can play both "same version again" and "moved on".
         *
         * @returns {Promise<void>}
         */
        const startManifestServer = () => new Promise((resolve) => {
            servedVersion = 'v2';
            manifestStatus = 200;
            server = http.createServer((req, res) => {
                requests.push(req.url);
                if (req.url.startsWith('/__browser/manifest.json')) {
                    if (manifestStatus !== 200) {
                        res.writeHead(manifestStatus);
                        res.end('nope');
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(manifestSource(servedVersion, 3));
                    }
                }
                // Assets never answer: the download stays in flight for the whole test.
            });
            server.listen(0, '127.0.0.1', () => {
                baseUrl = `http://127.0.0.1:${server.address().port}/`;
                resolve();
            });
        });

        /**
         * A manager wired to that server, whose callback records every outcome the Stage 4
         * contract defines and accepts every offered bundle.
         *
         * The default stall timeout is deliberately set rather than left at DEFAULT_HCP_STALL_TIMEOUT:
         * these downloads never finish, so their watchdog timer stays armed and holds the event loop
         * open until it fires — at the 300s default that is 3s of tests followed by five minutes of
         * an idle process. It must still be far longer than the test itself, or the watchdog's own
         * cancel() would be what sets cancelInvoked and the cancellation test would pass vacuously.
         *
         * @param {Object} appSettings - Desktop settings.json stand-in.
         *
         * @returns {Object} - { manager, events }
         */
        const buildForChecks = (appSettings = { hcpStallTimeout: 5000 }) => {
            const initialBundle = new AssetBundle(
                fakeLogger, writeBundleDir(path.join(root, 'initial'), 'initialversion', 1)
            );
            const manager = new AssetBundleManager(
                fakeLogger, { appId: 'appid', rootUrlString: baseUrl }, initialBundle, versionsDir, appSettings
            );
            const events = [];
            manager.setCallback({
                shouldDownloadBundleForManifest: () => true,
                onError: (cause) => events.push(['error', String(cause)]),
                onDownloadStarted: () => events.push(['started']),
                onDownloadProgress: () => events.push(['progress']),
                onDownloadAlreadyInProgress: (v) => events.push(['alreadyInProgress', v]),
                onFinishedDownloadingAssetBundle: () => events.push(['finished'])
            });
            return { manager, events };
        };

        // The renderer polls every 10 minutes and the production bundle takes longer than that on a
        // slow link, so this is the ordinary case, not a corner. Inversion: remove the
        // `this.assetBundleDownloader = assetBundleDownloader` assignment and a second 'started'
        // appears — two downloaders writing into one Downloading directory.
        it('does not start a second download of the version already downloading', async () => {
            await startManifestServer();
            const { manager, events } = buildForChecks();

            manager.checkForUpdates(baseUrl);
            await waitFor(() => events.some(([name]) => name === 'started'));
            manager.checkForUpdates(baseUrl);

            await waitFor(() => events.some(([name]) => name === 'alreadyInProgress'));
            expect(events.filter(([name]) => name === 'started')).to.have.lengthOf(1);
            expect(events.find(([name]) => name === 'alreadyInProgress')[1]).to.equal('v2');
        });

        // Stage 4's contract is that every check ends in exactly one observable outcome. This
        // branch returns without downloading, so before the event it produced none at all — which
        // is indistinguishable from a wedged check, the thing the contract exists to rule out.
        it('reports an outcome for the check it short-circuits', async () => {
            await startManifestServer();
            const { manager, events } = buildForChecks();

            manager.checkForUpdates(baseUrl);
            await waitFor(() => events.some(([name]) => name === 'started'));
            const emittedSoFar = events.length;
            manager.checkForUpdates(baseUrl);

            await waitFor(() => events.length > emittedSoFar);
            expect(events.slice(emittedSoFar).map(([name]) => name))
                .to.deep.equal(['alreadyInProgress']);
        });

        // The other dead guard: a check for a DIFFERENT version must stop the running download
        // before renaming the Downloading directory out from under it. Inversion: remove the
        // assignment and cancelInvoked stays false — both downloads keep writing to one directory.
        it('cancels a download in progress when the server moves to another version', async () => {
            await startManifestServer();
            const { manager, events } = buildForChecks();

            manager.checkForUpdates(baseUrl);
            await waitFor(() => events.some(([name]) => name === 'started'));
            const first = manager.assetBundleDownloader;
            expect(first).to.not.equal(null);
            expect(first.cancelInvoked).to.be.false();

            servedVersion = 'v3';
            manager.checkForUpdates(baseUrl);

            await waitFor(() => first.cancelInvoked === true);
            expect(first.getAssetBundle().getVersion()).to.equal('v2');
        });

        // Found by the adversarial review of this very change. Assigning the field revived the
        // guards, but didFail cleared it unconditionally — and didFail is reached by callers with
        // no download of their own, including a poll whose manifest fetch simply failed. So one
        // network blip put both guards straight back to sleep and the next check started a second
        // download into the same directory. Inversion: put `this.assetBundleDownloader = null`
        // back at the top of didFail and this test sees a second 'started'.
        it('keeps the in-flight slot when an unrelated check fails its manifest fetch', async () => {
            await startManifestServer();
            const { manager, events } = buildForChecks();

            manager.checkForUpdates(baseUrl);
            await waitFor(() => events.some(([name]) => name === 'started'));

            manifestStatus = 500;
            manager.checkForUpdates(baseUrl);
            await waitFor(() => events.some(([name]) => name === 'error'));

            manifestStatus = 200;
            manager.checkForUpdates(baseUrl);

            await waitFor(() => events.some(([name]) => name === 'alreadyInProgress'));
            expect(events.filter(([name]) => name === 'started')).to.have.lengthOf(1);
        });

        // A cancelled download's watchdog is still armed and cannot be reached by the canceller.
        // Left alone it fires minutes later and hands the renderer a "stalled" error for a version
        // it deliberately abandoned. Inversion: remove the cancelInvoked guard inside the stall
        // timer and a stall error naming v2 arrives.
        it('does not report a stall for a download it deliberately superseded', async () => {
            await startManifestServer();
            // 800ms rather than something tighter: v2's watchdog must not be able to beat the
            // second check's manifest fetch, or cancel() would arrive after the stall it is
            // supposed to pre-empt and this would fail for a reason that is not the code's.
            const { manager, events } = buildForChecks({ hcpStallTimeout: 800 });

            manager.checkForUpdates(baseUrl);
            await waitFor(() => events.some(([name]) => name === 'started'));
            servedVersion = 'v3';
            manager.checkForUpdates(baseUrl);
            await waitFor(() => events.filter(([name]) => name === 'started').length === 2);

            await new Promise((resolve) => { setTimeout(resolve, 1600); });
            const stalls = events
                .filter(([name, cause]) => name === 'error' && cause.includes('stalled'))
                .map(([, cause]) => cause);
            expect(stalls.some((cause) => cause.includes('version v2'))).to.be.false();
            // ...and the watchdog is still doing its job for the download that IS current.
            expect(stalls.some((cause) => cause.includes('version v3'))).to.be.true();
        });
    });
});
