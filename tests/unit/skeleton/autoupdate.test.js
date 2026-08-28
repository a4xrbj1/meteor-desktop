import * as chai from 'chai';
import dirty from 'dirty-chai';
import { EventEmitter } from 'events';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createRequire } from 'module';
import os from 'os';

chai.use(dirty);

const {
    describe, it, before, beforeEach, after, afterEach
} = global;
const { expect } = chai;
const require = createRequire(import.meta.url);

let HCPClient;
let AssetBundle;
let AssetBundleManager;
let AssetManifest;
let Module;
let utils;

const noop = () => {};
// HCPClient uses its logger directly (this.log.warn), unlike the autoupdate/* classes which call
// getLoggerFor first — so this is the raw shape, with getLoggerFor for the AssetManifest it builds.
const makeLogger = (warnings) => {
    // Self-returning: AssetBundle takes a sub-logger from getLoggerFor and hands it to
    // AssetManifest, which calls getLoggerFor again — every level of the real chain answers it.
    const logger = {
        debug: noop,
        verbose: noop,
        info: noop,
        warn: (message) => warnings.push(message),
        error: noop,
        getLoggerFor() {
            return logger;
        }
    };
    return logger;
};

const manifestJson = (extra) => JSON.stringify({
    format: 'web-program-pre1',
    version: 'newversion',
    manifest: [{
        path: 'app/app.js', url: '/app/app.js', type: 'js', where: 'client', cacheable: true, size: 1
    }],
    ...extra
});

/**
 * Builds a REAL HCPClient through its real constructor, with the real Module class and a real
 * EventEmitter — nothing the harness owns is stubbed. Only the two bundle fields the gate's
 * callers read are set directly, because populating them for real needs an on-disk bundle.
 *
 * @param {String|undefined} installedVersion - `version` in the built desktop settings.json.
 * @param {Array<String>} warnings - Collector the logger appends warnings to.
 *
 * @returns {Object} - { client, eventsBus, sent }
 */
const makeClient = (installedVersion, warnings, settings = {}) => {
    const eventsBus = new EventEmitter();
    const sent = [];
    Module.__setRendererForTest({
        isDestroyed: () => false,
        send: (event, ...data) => sent.push([event, ...data])
    });
    const client = new HCPClient({
        log: makeLogger(warnings),
        appSettings: installedVersion === undefined ? {} : { version: installedVersion },
        eventsBus,
        settings: { dataPath: os.tmpdir(), bundleStorePath: os.tmpdir(), ...settings },
        Module
    });
    client.currentAssetBundle = { getVersion: () => 'currentversion' };
    client.pendingAssetBundle = null;
    return { client, eventsBus, sent };
};

describe('autoupdate/utils#compareCoreVersions', () => {
    before(() => {
        utils = require('../../../skeleton/modules/autoupdate/utils.js').default;
    });

    it('orders by numeric component, not lexicographically', () => {
        // '5.10.0' < '5.9.0' as strings; the whole point of the gate is that it must not be.
        expect(utils.compareCoreVersions('5.10.0', '5.9.0')).to.be.above(0);
        expect(utils.compareCoreVersions('5.9.0', '5.10.0')).to.be.below(0);
    });

    it('treats a prerelease as equal to its release', () => {
        expect(utils.compareCoreVersions('5.1.4-beta.1', '5.1.4')).to.equal(0);
    });

    // A `v`-prefixed tag used to parse as [0, x, y], which would have refused every floored
    // bundle on a correctly-versioned app — the exact pathology the ordered compare avoids.
    it('tolerates a v prefix and build metadata', () => {
        expect(utils.compareCoreVersions('v5.3.0', '5.3.0')).to.equal(0);
        expect(utils.compareCoreVersions('v5.4.0', '5.3.0')).to.be.above(0);
        expect(utils.compareCoreVersions('5.3.0+build.7', '5.3.0')).to.equal(0);
    });

    it('treats missing components as zero', () => {
        expect(utils.compareCoreVersions('6', '6.0.0')).to.equal(0);
        expect(utils.compareCoreVersions('6.0.1', '6')).to.be.above(0);
    });
});

describe('HCPClient#shouldDownloadBundleForManifest — native compatibility gate', () => {
    let warnings;

    before(() => {
        HCPClient = require('../../../skeleton/modules/autoupdate.js').default;
        AssetManifest = require('../../../skeleton/modules/autoupdate/assetManifest.js').default;
        Module = require('../../../skeleton/modules/module.js').default;
    });

    after(() => {
        Module.__setRendererForTest(null);
    });

    beforeEach(() => {
        warnings = [];
    });

    it('accepts a bundle that declares no minimum (every existing app)', () => {
        const { client } = makeClient('5.3.0', warnings);
        const manifest = new AssetManifest(makeLogger(warnings), manifestJson());
        expect(client.shouldDownloadBundleForManifest(manifest)).to.be.true();
    });

    it('accepts when the installed native is exactly the declared minimum', () => {
        const { client } = makeClient('5.3.0', warnings);
        const manifest = new AssetManifest(makeLogger(warnings), manifestJson({ minDesktopVersion: '5.3.0' }));
        expect(client.shouldDownloadBundleForManifest(manifest)).to.be.true();
    });

    // The safe direction, and the reason the check is ordered rather than an equality test: right
    // after a native update, an already-pending older bundle still declares the older minimum.
    it('accepts an older bundle on a newer native', () => {
        const { client } = makeClient('5.4.0', warnings);
        const manifest = new AssetManifest(makeLogger(warnings), manifestJson({ minDesktopVersion: '5.3.0' }));
        expect(client.shouldDownloadBundleForManifest(manifest)).to.be.true();
    });

    // Inversion check (Rule 41): delete the isNativeCompatibleWithManifest call from
    // shouldDownloadBundleForManifest and this is the test that fails.
    it('refuses a bundle that needs a newer native, and says so on both channels', () => {
        const { client, eventsBus, sent } = makeClient('5.3.0', warnings);
        const received = [];
        eventsBus.on('nativeUpdateRequired', (payload) => received.push(payload));

        const manifest = new AssetManifest(makeLogger(warnings), manifestJson({ minDesktopVersion: '5.4.0' }));

        expect(client.shouldDownloadBundleForManifest(manifest)).to.be.false();
        expect(received).to.deep.equal([{ version: 'newversion', required: '5.4.0', installed: '5.3.0' }]);
        expect(sent).to.deep.equal([[
            'autoupdate__onNativeUpdateRequired',
            { version: 'newversion', required: '5.4.0', installed: '5.3.0' }
        ]]);
        expect(warnings.join('\n')).to.include('requires native version 5.4.0');
    });

    // A refusal must not blacklist: the same bundle has to be accepted once the native catches up.
    it('does not blacklist the refused version', () => {
        const { client } = makeClient('5.3.0', warnings);
        const manifest = new AssetManifest(makeLogger(warnings), manifestJson({ minDesktopVersion: '5.4.0' }));
        client.shouldDownloadBundleForManifest(manifest);
        expect(client.config.blacklistedVersions).to.deep.equal([]);
    });

    // Fail-open: a build with no version in its desktop settings must not lock itself out of HCP.
    it('accepts a v-prefixed installed version that satisfies the floor', () => {
        const { client } = makeClient('v5.4.0', warnings);
        const manifest = new AssetManifest(makeLogger(warnings), manifestJson({ minDesktopVersion: '5.4.0' }));
        expect(client.shouldDownloadBundleForManifest(manifest)).to.be.true();
    });

    it('accepts, with a warning, when the build has no version in its settings', () => {
        const { client, eventsBus } = makeClient(undefined, warnings);
        const received = [];
        eventsBus.on('nativeUpdateRequired', (payload) => received.push(payload));

        const manifest = new AssetManifest(makeLogger(warnings), manifestJson({ minDesktopVersion: '5.4.0' }));

        expect(client.shouldDownloadBundleForManifest(manifest)).to.be.true();
        expect(received).to.deep.equal([]);
        expect(warnings.join('\n')).to.include('no version in its desktop settings');
    });

    // The gate runs FIRST, ahead of the current/pending skips: the app is entitled to hear that a
    // native update is due even for a version the client happens to be holding.
    it('reports the mismatch even for the version already current', () => {
        const { client, eventsBus } = makeClient('5.3.0', warnings);
        client.currentAssetBundle = { getVersion: () => 'newversion' };
        const received = [];
        eventsBus.on('nativeUpdateRequired', (payload) => received.push(payload));

        const manifest = new AssetManifest(makeLogger(warnings), manifestJson({ minDesktopVersion: '5.4.0' }));

        expect(client.shouldDownloadBundleForManifest(manifest)).to.be.false();
        expect(received).to.have.lengthOf(1);
    });
});

describe('HCPClient — update-check phase events', () => {
    let warnings;
    let root;
    let server;
    let baseUrl;

    before(() => {
        HCPClient = require('../../../skeleton/modules/autoupdate.js').default;
        AssetBundle = require('../../../skeleton/modules/autoupdate/assetBundle.js').default;
        AssetBundleManager = require('../../../skeleton/modules/autoupdate/assetBundleManager.js').default;
        AssetManifest = require('../../../skeleton/modules/autoupdate/assetManifest.js').default;
        Module = require('../../../skeleton/modules/module.js').default;
    });

    after(() => {
        Module.__setRendererForTest(null);
    });

    beforeEach(() => {
        warnings = [];
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hcp-'));
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

    it('fires updateNotAvailable when the server offers the version we are already on', () => {
        const { client, eventsBus, sent } = makeClient('5.3.0', warnings);
        client.currentAssetBundle = { getVersion: () => 'newversion' };
        const received = [];
        eventsBus.on('updateNotAvailable', (version) => received.push(version));

        expect(client.shouldDownloadBundleForManifest(
            new AssetManifest(makeLogger(warnings), manifestJson())
        )).to.be.false();
        expect(received).to.deep.equal(['newversion']);
        expect(sent).to.deep.equal([['autoupdate__onUpdateNotAvailable', 'newversion']]);
    });

    it('fires updateNotAvailable for a version already pending', () => {
        const { client, eventsBus } = makeClient('5.3.0', warnings);
        client.pendingAssetBundle = { getVersion: () => 'newversion' };
        const received = [];
        eventsBus.on('updateNotAvailable', (version) => received.push(version));

        expect(client.shouldDownloadBundleForManifest(
            new AssetManifest(makeLogger(warnings), manifestJson())
        )).to.be.false();
        expect(received).to.deep.equal(['newversion']);
    });

    // A blacklisted version already reports through notifyError; firing updateNotAvailable there
    // too would give one skip two contradictory meanings.
    it('does not fire updateNotAvailable for a blacklisted version', () => {
        const { client, eventsBus } = makeClient('5.3.0', warnings);
        client.config.blacklistedVersions = ['newversion'];
        const received = [];
        eventsBus.on('updateNotAvailable', (version) => received.push(version));

        expect(client.shouldDownloadBundleForManifest(
            new AssetManifest(makeLogger(warnings), manifestJson())
        )).to.be.false();
        expect(received).to.deep.equal([]);
    });

    // No silent window: a check against a server that accepts the connection and never answers
    // used to emit nothing at all, forever. It now announces the start and then fails.
    // Inversion: delete the notifyUpdateCheckStarted call and the first assertion fails.
    it('announces the start of a check, and still terminates when the server hangs', async () => {
        await new Promise((resolve) => {
            server = http.createServer(() => {});
            server.listen(0, '127.0.0.1', () => {
                baseUrl = `http://127.0.0.1:${server.address().port}/`;
                resolve();
            });
        });

        const bundleDir = path.join(root, 'initial');
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.writeFileSync(path.join(bundleDir, 'program.json'), manifestJson({ version: 'initialversion' }));
        fs.writeFileSync(path.join(bundleDir, 'index.html'), '<html></html>');
        const versionsDir = path.join(root, 'versions');
        fs.mkdirSync(versionsDir);

        // hcpRequestTimeout is read by the AssetBundleManager off appSettings, NOT from these
        // settings — hence the explicit appSettings on the manager built below.
        const { client, eventsBus, sent } = makeClient('5.3.0', warnings, { customHCPUrl: baseUrl });
        const bundleLogger = makeLogger(warnings);
        const initialBundle = new AssetBundle(bundleLogger, bundleDir);
        client.assetBundleManager = new AssetBundleManager(
            bundleLogger, client.config, initialBundle, versionsDir, { hcpRequestTimeout: 200 }
        );
        client.assetBundleManager.setCallback(client);

        const phases = [];
        eventsBus.on('updateCheckStarted', (rootUrl) => phases.push(['started', rootUrl]));

        client.checkForUpdates();

        expect(phases).to.deep.equal([['started', baseUrl]]);
        expect(sent).to.deep.equal([['autoupdate__onUpdateCheckStarted', baseUrl]]);

        // ...and it terminates rather than hanging: the manifest fetch's AbortSignal turns the
        // dead connection into an ordinary error the renderer hears about.
        await new Promise((resolve) => { setTimeout(resolve, 800); });
        const errors = sent.filter(([event]) => event === 'autoupdate__error');
        expect(errors).to.have.lengthOf(1);
        expect(errors[0][1]).to.include('error querying asset manifest');
    });
});
