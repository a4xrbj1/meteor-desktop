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

        // The watchdog must not kill a download that is making progress. 18 assets at 120ms with
        // the downloader's concurrency of 6 is three waves, ~360ms — deliberately LONGER than the
        // 250ms window, so only the re-arm on each completed asset can carry it through.
        // Inversion: delete armStallTimer() from the progress callback and this fails with a
        // stall error partway through the third wave.
        it('does not fire while assets keep completing', async () => {
            await startServer(120);
            const { manager, downloadBundle, events } = build({ hcpStallTimeout: 250 }, 18);

            manager.downloadAssetBundle(downloadBundle, baseUrl);

            await waitFor(() => events.some(([name]) => name === 'finished'));
            expect(events.some(([name]) => name === 'error')).to.be.false();
            // ...and the timer is disarmed on success: nothing fires after the bundle lands.
            await new Promise((resolve) => { setTimeout(resolve, 400); });
            expect(events.filter(([name]) => name === 'error')).to.have.lengthOf(0);
        });
    });
});
