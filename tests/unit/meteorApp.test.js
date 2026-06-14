/* eslint-disable global-require, import-x/extensions */
import * as chai from 'chai';
import dirty from 'dirty-chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

// need for running test
import * as asar from '@electron/asar'; // eslint-disable-line no-unused-vars

chai.use(sinonChai);
chai.use(dirty);

const {
    describe, it, before, after, afterEach
} = global;
const { expect } = chai;
const require = createRequire(import.meta.url);

const METEOR_APP_CONTEXT = { env: { paths: { meteorApp: { release: 'release.file' } } } };
const METEOR_RELEASES = [
    { release: 'METEOR@1.3.4', version: '1.3.4', semver: '1.3.4' },
    { release: 'METEOR@1.4.2.7', version: '1.4.2.7', semver: '1.4.2' },
    { release: 'METEOR@1.5-alpha', version: '1.5', semver: '1.5.0' },
    { release: 'METEOR@2-rc.0', version: '2', semver: '2.0.0' },
    { release: 'METEOR@1.6.0.1\r\n\r\n', version: '1.6.0.1', semver: '1.6.0' }
];

let MeteorApp;
let meteorAppTestExports;
let readFileSyncStub;
let tempDirToRemove;

const meteorAppModulePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../lib/meteorApp.js');
const meteorAppLibDir = path.dirname(meteorAppModulePath);

const loadMeteorAppTestExports = async function () {
    const sourcePath = path.join(meteorAppLibDir, 'meteorApp.js');
    const tempModulePath = path.join(meteorAppLibDir, '__meteorApp.test.mjs');
    const originalSource = fs.readFileSync(sourcePath, 'UTF-8');
    const testableSource = `${originalSource}

export {
    patchClientBundleJs,
    hasResidualClientEsmPatterns,
    reconcileIndexHtmlScriptsWithManifest
};
`;

    fs.writeFileSync(tempModulePath, testableSource, 'UTF-8');

    try {
        return await import(`${pathToFileURL(tempModulePath).href}?ts=${Date.now()}`);
    } finally {
        fs.rmSync(tempModulePath, { force: true });
    }
};

describe('meteorApp', () => {
    before(async () => {
        MeteorApp = (await import('../../lib/meteorApp.js')).default;
        meteorAppTestExports = await loadMeteorAppTestExports();
    });

    after(() => {
        if (readFileSyncStub) {
            readFileSyncStub.restore();
        }
        if (tempDirToRemove) {
            fs.rmSync(tempDirToRemove, { recursive: true, force: true });
        }
    });

    function prepareFsStubs(release) {
        if (readFileSyncStub) {
            readFileSyncStub.restore();
        }
        readFileSyncStub = sinon.stub(fs, 'readFileSync');
        readFileSyncStub
            .withArgs(sinon.match('release.file'), 'utf8')
            .returns(release);
    }

    describe('#castMeteorReleaseToSemver', () => {
        it('should cast release to semver', () => {
            const instance = new MeteorApp(METEOR_APP_CONTEXT);
            METEOR_RELEASES.forEach((version) => {
                prepareFsStubs(version.release);
                expect(instance.castMeteorReleaseToSemver()).be.equal(version.semver);
            });
        });
    });

    describe('#getMeteorRelease', () => {
        it('should parse Meteor version', () => {
            const instance = new MeteorApp(METEOR_APP_CONTEXT);
            METEOR_RELEASES.forEach((version) => {
                prepareFsStubs(version.release);
                expect(instance.getMeteorRelease()).be.equal(version.version);
            });
        });
    });

    describe('#injectEsm', () => {
        it('should patch import.meta inside dynamic js files', () => {
            if (readFileSyncStub) {
                readFileSyncStub.restore();
                readFileSyncStub = null;
            }
            tempDirToRemove = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-inject-esm-'));
            const dynamicDir = path.join(tempDirToRemove, 'dynamic', 'node_modules', '@zip.js', 'zip.js', 'lib');
            const rootBundlePath = path.join(tempDirToRemove, 'bundle.js');
            const indexHtmlPath = path.join(tempDirToRemove, 'index.html');
            const dynamicFilePath = path.join(dynamicDir, 'zip-core-base.js');

            fs.mkdirSync(dynamicDir, { recursive: true });
            fs.writeFileSync(rootBundlePath, 'var global = this;');
            fs.writeFileSync(dynamicFilePath, 'try{configure({ baseURI: import.meta.url })}catch{}');
            fs.writeFileSync(indexHtmlPath, '<html><head></head><body><script src="/bundle.js"></script></body></html>');

            const instance = new MeteorApp({
                env: {
                    paths: {
                        electronApp: {
                            meteorApp: tempDirToRemove,
                            meteorAppIndex: indexHtmlPath
                        },
                        meteorApp: {
                            release: 'release.file'
                        }
                    }
                }
            });

            instance.injectEsm();

            expect(fs.readFileSync(dynamicFilePath, 'UTF-8')).to.not.include('import.meta');
            expect(fs.readFileSync(dynamicFilePath, 'UTF-8')).to.include('({url: location.href}).url');
        });
    });

    describe('#injectEsm chunk scraper', () => {
        const writeFixture = function (tempDir, files) {
            Object.keys(files).forEach((rel) => {
                const target = path.join(tempDir, rel);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, files[rel]);
            });
        };

        const newInstance = function (tempDir) {
            return new MeteorApp({
                env: {
                    options: {},
                    paths: {
                        electronApp: {
                            meteorApp: tempDir,
                            meteorAppIndex: path.join(tempDir, 'index.html')
                        },
                        meteorApp: {
                            release: 'release.file',
                            root: tempDir,
                            rspack: { buildContext: '_build' }
                        }
                    }
                }
            });
        };

        // A chunksRefs URL whose file is bundled under app/ but whose URL is not
        // present in program.json (orphan-bundled) must not trigger a redundant
        // root-level copy. The original app/ file must remain untouched and the
        // manifest must gain an entry pointing at the authoritative app/ path so
        // the runtime AssetHandler can resolve the URL. The fixture also stages
        // a stale disk source at _build/main-prod/build-chunks-local-desktop/main.css
        // so the scraper's diskSource probe WOULD copy a redundant root-level
        // file without the app/ short-circuit — this forces the test to exercise
        // the actual changed guard rather than passing because all sources missed.
        const orphanFixture = {
            'dynamic/foo.js': 'var global = this;',
            'index.html': '<html><head>'
                + '<link href="/build-chunks-local-desktop/main.css" rel="stylesheet">'
                + '</head><body><script src="/bundle.js"></script></body></html>',
            'bundle.js': 'var global = this;',
            '_build/main-prod/client-rspack.js': '// rspack client bundle\n'.repeat(500),
            '_build/main-prod/index.html': '<html><head>'
                + '<link href="/build-chunks-local-desktop/main.css" rel="stylesheet">'
                + '</head><body></body></html>',
            '_build/main-prod/build-chunks-local-desktop/main.css': '.stale-disk { color: blue; }',
            'app/build-chunks-local-desktop/main.css': '.real-css { color: red; }',
            'program.json': JSON.stringify({ manifest: [] })
        };

        it('skips writing a redundant root-level copy when only the app/ copy exists', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-scraper-'));
            writeFixture(tempDir, orphanFixture);
            try {
                await newInstance(tempDir).injectEsm();
                expect(fs.existsSync(path.join(tempDir, 'build-chunks-local-desktop/main.css')))
                    .to.equal(false);
                const appCopy = fs.readFileSync(
                    path.join(tempDir, 'app/build-chunks-local-desktop/main.css'), 'UTF-8'
                );
                expect(appCopy).to.equal('.real-css { color: red; }');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('adds a manifest entry pointing at app/ when the URL is missing from program.json', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-scraper-'));
            writeFixture(tempDir, orphanFixture);
            try {
                await newInstance(tempDir).injectEsm();
                const pj = JSON.parse(
                    fs.readFileSync(path.join(tempDir, 'program.json'), 'UTF-8')
                );
                const entry = pj.manifest.find(
                    (e) => e.url === '/build-chunks-local-desktop/main.css'
                );
                expect(entry).to.not.equal(undefined);
                expect(entry.path).to.equal('app/build-chunks-local-desktop/main.css');
                expect(entry.type).to.equal('css');
                expect(entry.where).to.equal('client');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        // Seed meteor-desktop-4a0d: the network-fetch branch of the scraper trusted
        // res.ok alone. Meteor's dev server returns HTTP 200 + text/html for any path
        // it does not serve, so a missing chunk got written into the asar as HTML and
        // was only caught post-hoc by A3.5 Check 4's magic-byte scan. The guard
        // checks res.headers.get('content-type') against the URL extension before
        // writing — these two tests pin that contract on the network branch.
        const networkFixture = {
            'dynamic/foo.js': 'var global = this;',
            'index.html': '<html><head></head><body>'
                + '<script src="/__rspack__/dynamic-chunk.js"></script>'
                + '<script src="/bundle.js"></script></body></html>',
            'bundle.js': 'var global = this;',
            '_build/main-prod/client-rspack.js': '// rspack client bundle\n',
            'program.json': JSON.stringify({ manifest: [] })
        };

        it('rejects a network response whose content-type does not match the URL extension', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-net-ct-'));
            writeFixture(tempDir, networkFixture);
            const fetchStub = sinon.stub(global, 'fetch').resolves(
                new Response('<!DOCTYPE html><html>Meteor App - Error</html>', {
                    status: 200,
                    headers: { 'content-type': 'text/html; charset=utf-8' }
                })
            );
            try {
                let thrown = null;
                try {
                    await newInstance(tempDir).injectEsm();
                } catch (e) {
                    thrown = e;
                }
                expect(thrown, 'A2.7 must fire when no port returns a matching content-type')
                    .to.not.equal(null);
                expect(thrown.message).to.match(/A2\.7: rspack asset .*dynamic-chunk\.js missing/);
                expect(fs.existsSync(path.join(tempDir, '__rspack__/dynamic-chunk.js')),
                    'HTML must not be written under a .js path')
                    .to.equal(false);
                expect(fetchStub.called).to.equal(true);
            } finally {
                fetchStub.restore();
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('writes the buffer when content-type matches the URL extension', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-net-ok-'));
            writeFixture(tempDir, networkFixture);
            const body = 'export const chunk = 1;\n';
            const fetchStub = sinon.stub(global, 'fetch').resolves(
                new Response(body, {
                    status: 200,
                    headers: { 'content-type': 'application/javascript' }
                })
            );
            try {
                await newInstance(tempDir).injectEsm();
                const written = path.join(tempDir, '__rspack__/dynamic-chunk.js');
                expect(fs.existsSync(written), 'chunk must be written to localPath').to.equal(true);
                expect(fs.readFileSync(written, 'UTF-8')).to.equal(body);
            } finally {
                fetchStub.restore();
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        // A2.7 GATEWAY CHECK: if a discovered rspack chunk url has no on-disk file
        // (neither at meteorAppDir/<rel> nor at meteorAppDir/app/<rel>) and is absent
        // from program.json's manifest, injectEsm MUST abort the build. The inner
        // try/catch around the chunk scraper used to swallow this throw (see seed
        // meteor-desktop-5204); this test pins the rethrow contract.
        it('throws past the inner catch when the A2.7 gate finds a missing rspack asset', async () => {
            const missingFixture = {
                'dynamic/foo.js': 'var global = this;',
                'index.html': '<html><head></head><body>'
                    + '<script src="/__rspack__/missing-chunk.js"></script>'
                    + '<script src="/bundle.js"></script></body></html>',
                'bundle.js': 'var global = this;',
                // PATCH 2b probes _build/{main-prod,main-dev}/client-rspack.js BEFORE
                // the chunk scraper runs — supply the main bundle so we reach A2.7.
                '_build/main-prod/client-rspack.js': '// rspack client bundle\n',
                'program.json': JSON.stringify({ manifest: [] })
            };
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a27-'));
            writeFixture(tempDir, missingFixture);
            try {
                let thrown = null;
                try {
                    await newInstance(tempDir).injectEsm();
                } catch (e) {
                    thrown = e;
                }
                expect(thrown, 'A2.7 must abort the build').to.not.equal(null);
                expect(thrown.message).to.match(/A2\.7: rspack asset .*missing-chunk\.js missing/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('#validateHashCoherence stylesheet links', () => {
        const writeFixture = function (files) {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a25-css-'));
            Object.keys(files).forEach((rel) => {
                const target = path.join(tempDir, rel);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, files[rel]);
            });
            return tempDir;
        };

        const newInstance = function (tempDir, optionOverrides) {
            return new MeteorApp({
                env: {
                    options: { skipMobileBuild: false, ...optionOverrides },
                    paths: {
                        electronApp: {
                            meteorApp: tempDir,
                            meteorAppIndex: path.join(tempDir, 'index.html')
                        },
                        meteorApp: { release: 'release.file' }
                    }
                }
            });
        };

        const desktopCssManifest = JSON.stringify({
            manifest: [{
                url: '/build-chunks-local-desktop/main.50dab1a8aa8e6b42.css',
                path: 'app/build-chunks-local-desktop/main.50dab1a8aa8e6b42.css',
                type: 'asset'
            }]
        });

        it('rewrites an unhashed rspack stylesheet href to its hashed manifest url', () => {
            const tempDir = writeFixture({
                'index.html': '<html><head><link href="/build-chunks-local-desktop/main.css" '
                    + 'rel="stylesheet"></head><body></body></html>',
                'program.json': desktopCssManifest
            });

            try {
                newInstance(tempDir).validateHashCoherence();
                const html = fs.readFileSync(path.join(tempDir, 'index.html'), 'UTF-8');
                expect(html).to.include('href="/build-chunks-local-desktop/main.50dab1a8aa8e6b42.css"');
                expect(html).to.not.include('href="/build-chunks-local-desktop/main.css"');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('prunes a foreign-context stylesheet link that has no bundled asset', () => {
            const tempDir = writeFixture({
                'index.html': '<html><head>\n'
                    + '<link href="/build-chunks-local/main.css" rel="stylesheet">\n'
                    + '<link href="/build-chunks-local-desktop/main.css" rel="stylesheet">\n'
                    + '</head><body></body></html>',
                'program.json': desktopCssManifest
            });

            try {
                newInstance(tempDir).validateHashCoherence();
                const html = fs.readFileSync(path.join(tempDir, 'index.html'), 'UTF-8');
                expect(html).to.include('href="/build-chunks-local-desktop/main.50dab1a8aa8e6b42.css"');
                expect(html).to.not.include('/build-chunks-local/main.css');
                expect(html).to.not.include('href="/build-chunks-local-desktop/main.css"');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('throws when every stylesheet link is unresolvable', () => {
            const tempDir = writeFixture({
                'index.html': '<html><head><link href="/build-chunks-local/main.css" '
                    + 'rel="stylesheet"></head><body></body></html>',
                'program.json': JSON.stringify({ manifest: [] })
            });

            try {
                expect(() => newInstance(tempDir).validateHashCoherence())
                    .to.throw(/style-less desktop build/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('keeps unresolvable stylesheet links in dev mode (skipMobileBuild) instead of throwing', () => {
            const tempDir = writeFixture({
                'index.html': '<html><head><link href="/build-chunks-local/main.css" '
                    + 'rel="stylesheet"></head><body></body></html>',
                'program.json': JSON.stringify({ manifest: [] })
            });

            try {
                expect(() => newInstance(tempDir, { skipMobileBuild: true }).validateHashCoherence())
                    .to.not.throw();
                const html = fs.readFileSync(path.join(tempDir, 'index.html'), 'UTF-8');
                expect(html).to.include('href="/build-chunks-local/main.css"');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('leaves non-stylesheet <link> tags (favicons) untouched', () => {
            const tempDir = writeFixture({
                'index.html': '<html><head>\n'
                    + '<link rel="shortcut icon" type="image/png" href="/favicon-194x194.png">\n'
                    + '<link href="/build-chunks-local-desktop/main.css" rel="stylesheet">\n'
                    + '</head><body></body></html>',
                'program.json': desktopCssManifest
            });

            try {
                newInstance(tempDir).validateHashCoherence();
                const html = fs.readFileSync(path.join(tempDir, 'index.html'), 'UTF-8');
                expect(html).to.include('<link rel="shortcut icon" type="image/png" href="/favicon-194x194.png">');
                expect(html).to.include('href="/build-chunks-local-desktop/main.50dab1a8aa8e6b42.css"');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('meteorApp helper functions', () => {
        it('should patch global scope and import.meta usages in client bundles', () => {
            const { patchClientBundleJs, hasResidualClientEsmPatterns } = meteorAppTestExports;
            const originalSource = [
                'var global = this;',
                'global = this;',
                '}).call(this)',
                'console.log(import.meta.url);'
            ].join('\n');

            const patchedSource = patchClientBundleJs(originalSource);

            expect(patchedSource).to.include('var global = window;');
            expect(patchedSource).to.include('global = window;');
            expect(patchedSource).to.include('}).call(this || window)');
            expect(patchedSource).to.include('({url: location.href}).url');
            expect(hasResidualClientEsmPatterns(patchedSource)).to.be.false();
        });

        it('should patch bare Package assignments and app safe-init globals when requested', () => {
            const { patchClientBundleJs, hasResidualClientEsmPatterns } = meteorAppTestExports;
            const originalSource = [
                'CollectionExtensions = Package["omega:collection-extensions"].CollectionExtensions;',
                "if (typeof CollectionExtensions === 'undefined') { CollectionExtensions = {}; }",
                'var require = meteorInstall;'
            ].join('\n');

            const patchedSource = patchClientBundleJs(originalSource, true, true);

            expect(patchedSource).to.include('window.CollectionExtensions = Package');
            expect(patchedSource).to.include("if (typeof window.CollectionExtensions === 'undefined') { window.CollectionExtensions =");
            expect(patchedSource).to.include('var require = window.meteorInstall');
            expect(hasResidualClientEsmPatterns(patchedSource, true)).to.be.false();
        });

        it('should detect residual bare Package assignments when requested', () => {
            const { hasResidualClientEsmPatterns } = meteorAppTestExports;
            const originalSource = 'CollectionExtensions = Package["omega:collection-extensions"].CollectionExtensions;';

            expect(hasResidualClientEsmPatterns(originalSource)).to.be.false();
            expect(hasResidualClientEsmPatterns(originalSource, true)).to.be.true();
        });

        it('should leave already aligned index.html script tags untouched', () => {
            const { reconcileIndexHtmlScriptsWithManifest } = meteorAppTestExports;
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-reconcile-aligned-'));
            const indexHtmlPath = path.join(tempDir, 'index.html');
            const logger = { info: sinon.stub() };

            fs.writeFileSync(
                indexHtmlPath,
                '<html><head></head><body><script>window.inline = true;</script><script src="https://cdn.example.com/runtime.js"></script><script src="/packages/session.js?hash=1"></script><script src="/app.js?hash=2"></script></body></html>'
            );

            try {
                const result = reconcileIndexHtmlScriptsWithManifest(indexHtmlPath, {
                    manifest: [
                        { type: 'js', url: '/packages/session.js?hash=1' },
                        { type: 'js', url: '/app.js?hash=2' }
                    ]
                }, logger);

                expect(result).to.deep.equal({
                    changed: false,
                    localScriptCount: 2,
                    manifestScriptCount: 2,
                    reason: 'already aligned'
                });
                expect(logger.info).to.not.have.been.called();
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('should rewrite only the local script block when manifest urls drift', () => {
            const { reconcileIndexHtmlScriptsWithManifest } = meteorAppTestExports;
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-reconcile-rewrite-'));
            const indexHtmlPath = path.join(tempDir, 'index.html');
            const logger = { info: sinon.stub() };

            fs.writeFileSync(
                indexHtmlPath,
                '<html><head></head><body><script>window.inline = true;</script><script src="https://cdn.example.com/runtime.js"></script><script src="/app.js?hash=stale"></script></body></html>'
            );

            try {
                const result = reconcileIndexHtmlScriptsWithManifest(indexHtmlPath, {
                    manifest: [
                        { type: 'js', url: '/packages/session.js?hash=new-session' },
                        { type: 'js', url: '/app.js?hash=new-app' }
                    ]
                }, logger);
                const reconciledHtml = fs.readFileSync(indexHtmlPath, 'UTF-8');

                expect(result).to.deep.equal({
                    changed: true,
                    localScriptCount: 1,
                    manifestScriptCount: 2,
                    reason: 'rewrote local script block'
                });
                expect(reconciledHtml).to.include('<script>window.inline = true;</script>');
                expect(reconciledHtml).to.include('<script src="https://cdn.example.com/runtime.js"></script>');
                expect(reconciledHtml).to.include('/packages/session.js?hash=new-session');
                expect(reconciledHtml).to.include('/app.js?hash=new-app');
                expect(reconciledHtml).to.not.include('stale');
                expect(logger.info).to.have.been.calledOnce();
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('should skip reconciliation when the index has no local script tags', () => {
            const { reconcileIndexHtmlScriptsWithManifest } = meteorAppTestExports;
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-reconcile-remote-'));
            const indexHtmlPath = path.join(tempDir, 'index.html');
            const logger = { info: sinon.stub() };

            fs.writeFileSync(
                indexHtmlPath,
                '<html><head></head><body><script>window.inline = true;</script><script src="https://cdn.example.com/runtime.js"></script></body></html>'
            );

            try {
                const result = reconcileIndexHtmlScriptsWithManifest(indexHtmlPath, {
                    manifest: [
                        { type: 'js', url: '/app.js?hash=new-app' }
                    ]
                }, logger);

                expect(result).to.deep.equal({
                    changed: false,
                    localScriptCount: 0,
                    manifestScriptCount: 1,
                    reason: 'index has no local script tags'
                });
                expect(logger.info).to.not.have.been.called();
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('#checkPreconditions mobile platform auto-add', () => {
        let preconditionTempDir;

        const setupInstance = function (chosenStrategy) {
            if (readFileSyncStub) {
                readFileSyncStub.restore();
                readFileSyncStub = null;
            }
            preconditionTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-precond-'));
            const platformsPath = path.join(preconditionTempDir, 'platforms');
            fs.writeFileSync(platformsPath, 'browser\nserver\n', 'utf8');

            const instance = new MeteorApp({
                env: {
                    options: { skipMobileBuild: false },
                    paths: {
                        meteorApp: {
                            release: path.join(preconditionTempDir, 'release'),
                            platforms: platformsPath
                        }
                    }
                }
            });
            instance.checkMeteorVersion = sinon.stub();
            instance.chooseStrategy = sinon.stub().returns(chosenStrategy);
            instance.addMobilePlatform = sinon.stub().resolves();
            return { instance, platformsPath };
        };

        afterEach(() => {
            if (preconditionTempDir) {
                fs.rmSync(preconditionTempDir, { recursive: true, force: true });
                preconditionTempDir = null;
            }
        });

        it('does not auto-add a mobile platform when strategy is INDEX_FROM_RUNNING_SERVER', async () => {
            const probeInstance = new MeteorApp({ env: { paths: { meteorApp: { release: 'release.file' } } } });
            const { instance, platformsPath } = setupInstance(probeInstance.indexHTMLStrategies.INDEX_FROM_RUNNING_SERVER);

            await instance.checkPreconditions();

            expect(instance.addMobilePlatform).to.not.have.been.called();
            expect(instance.mobilePlatform).to.equal(null);
            expect(fs.readFileSync(platformsPath, 'utf8')).to.equal('browser\nserver\n');
        });

        it('auto-adds iOS when strategy is INDEX_FROM_LOCAL_BUILD and no mobile platform is present', async () => {
            const probeInstance = new MeteorApp({ env: { paths: { meteorApp: { release: 'release.file' } } } });
            const { instance } = setupInstance(probeInstance.indexHTMLStrategies.INDEX_FROM_LOCAL_BUILD);

            await instance.checkPreconditions();

            expect(instance.addMobilePlatform).to.have.been.calledOnceWithExactly('ios');
            expect(instance.mobilePlatform).to.equal('ios');
        });
    });

    describe('#copyBuild', () => {
        it('should reconcile downloaded index scripts with authoritative manifest urls', async () => {
            if (readFileSyncStub) {
                readFileSyncStub.restore();
                readFileSyncStub = null;
            }

            tempDirToRemove = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-copy-build-'));
            const webBrowserDir = path.join(tempDirToRemove, 'web.browser');
            const meteorAppDir = path.join(tempDirToRemove, 'desktop-build', 'meteor');
            const meteorAppIndex = path.join(meteorAppDir, 'index.html');
            const webBrowserProgramJson = path.join(webBrowserDir, 'program.json');
            const buildIndex = path.join(webBrowserDir, 'index.html');
            const bundleFilePath = path.join(webBrowserDir, 'app.js');
            const sessionFilePath = path.join(webBrowserDir, 'packages', 'session.js');

            fs.mkdirSync(path.join(webBrowserDir, 'packages'), { recursive: true });
            fs.mkdirSync(meteorAppDir, { recursive: true });
            fs.writeFileSync(buildIndex, '<html><head></head><body>local build</body></html>');
            fs.writeFileSync(bundleFilePath, 'console.log("app");');
            fs.writeFileSync(sessionFilePath, 'console.log("session");');
            fs.writeFileSync(
                webBrowserProgramJson,
                JSON.stringify({
                    manifest: [
                        { path: 'packages/session.js', url: '/packages/session.js?hash=new-session', type: 'js' },
                        { path: 'app.js', url: '/app.js?hash=new-app', type: 'js' }
                    ]
                })
            );

            const instance = new MeteorApp({
                env: {
                    os: { isWindows: false },
                    paths: {
                        electronApp: {
                            meteorApp: meteorAppDir,
                            meteorAppIndex,
                            meteorAppProgramJson: path.join(meteorAppDir, 'program.json')
                        },
                        meteorApp: {
                            release: 'release.file',
                            webBrowser: webBrowserDir,
                            webBrowserProgramJson,
                            legacyBuild: path.join(tempDirToRemove, 'legacy'),
                            legacyBuildIndex: path.join(tempDirToRemove, 'legacy', 'index.html')
                        }
                    }
                },
                utils: {
                    exists: (filePath) => fs.existsSync(filePath),
                    rmWithRetries: async function () {
                        fs.rmSync(meteorAppDir, { recursive: true, force: true });
                    }
                },
                electronApp: { validationGatesPassed: [] }
            });

            instance.indexHTMLstrategy = instance.indexHTMLStrategies.INDEX_FROM_RUNNING_SERVER;
            instance.acquireIndex = function () {
                return Promise.resolve('<html><head></head><body><script src="/app.js?hash=stale-app"></script></body></html>');
            };
            instance.validateBundleStructure = function () {};

            await instance.copyBuild();

            const copiedIndex = fs.readFileSync(meteorAppIndex, 'UTF-8');
            expect(copiedIndex).to.include('/packages/session.js?hash=new-session');
            expect(copiedIndex).to.include('/app.js?hash=new-app');
            expect(copiedIndex).to.not.include('stale-app');
        });
    });

    describe('#validateRuntimeConfigUrls', () => {
        // Seed e2e-4193 — A2.6 gate: catches the 'http://build/' placeholder Meteor
        // emits when the inner 'meteor run' is contended by a leftover meteor-desktop
        // or rspack watcher and acquireIndex() got back half-initialised HTML.

        const writeIndexWithRuntimeConfig = function (dir, runtimeConfig) {
            const encoded = encodeURIComponent(JSON.stringify(runtimeConfig));
            const html = '<html><head>'
                + `<script>__meteor_runtime_config__ = JSON.parse(decodeURIComponent("${encoded}"))</script>`
                + '</head><body></body></html>';
            const indexPath = path.join(dir, 'index.html');
            fs.writeFileSync(indexPath, html);
            return indexPath;
        };

        const buildInstance = function (indexPath, ddpUrl) {
            return new MeteorApp({
                env: {
                    paths: {
                        electronApp: { meteorAppIndex: indexPath },
                        meteorApp: { release: 'release.file' }
                    },
                    options: { ddpUrl }
                }
            });
        };

        let dir;
        afterEach(() => {
            if (dir) {
                fs.rmSync(dir, { recursive: true, force: true });
                dir = null;
            }
        });

        it('passes when ROOT_URL is the configured ddpUrl', () => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a26-'));
            const indexPath = writeIndexWithRuntimeConfig(dir, {
                ROOT_URL: 'http://127.0.0.1:3000/',
                DDP_DEFAULT_CONNECTION_URL: 'http://127.0.0.1:3000/'
            });
            const instance = buildInstance(indexPath, 'http://127.0.0.1:3000');
            expect(() => instance.validateRuntimeConfigUrls()).to.not.throw();
        });

        it('passes in dev mode (ddpUrl null) when only ROOT_URL is present — real shape: DDP key absent from JSON', () => {
            // Real shape captured from frontend/.meteor/desktop-build/meteor/index.html
            // after a passing `meteor run` (dev mode): the serialised __meteor_runtime_config__
            // contains ROOT_URL but no DDP_DEFAULT_CONNECTION_URL key at all. The runtime
            // recovery layer at skeleton/app.js:953-960 sets DDP at request time.
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a26-'));
            const indexPath = writeIndexWithRuntimeConfig(dir, {
                meteorRelease: 'METEOR@3.4.1',
                ROOT_URL: 'http://localhost:3000/',
                ROOT_URL_PATH_PREFIX: '',
                appId: 'pzkp2619zyzxgsarhim',
                isModern: false
            });
            const instance = buildInstance(indexPath, null);
            expect(() => instance.validateRuntimeConfigUrls()).to.not.throw();
        });

        it("throws when ROOT_URL hostname is 'build' (the e2e-4193 failure mode) with watcher-contention hint", () => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a26-'));
            const indexPath = writeIndexWithRuntimeConfig(dir, {
                ROOT_URL: 'http://build/',
                DDP_DEFAULT_CONNECTION_URL: 'http://build/'
            });
            const instance = buildInstance(indexPath, 'http://127.0.0.1:3000');
            expect(() => instance.validateRuntimeConfigUrls())
                .to.throw(/A2\.6 runtime-config URL gate failed.*ROOT_URL hostname is 'build'/s)
                .and.to.match(/meteor-desktop or rspack watcher/);
        });

        it("throws when DDP_DEFAULT_CONNECTION_URL hostname is 'build' but ROOT_URL is fine — with watcher hint", () => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a26-'));
            const indexPath = writeIndexWithRuntimeConfig(dir, {
                ROOT_URL: 'http://127.0.0.1:3000/',
                DDP_DEFAULT_CONNECTION_URL: 'http://build/'
            });
            const instance = buildInstance(indexPath, 'http://127.0.0.1:3000');
            expect(() => instance.validateRuntimeConfigUrls())
                .to.throw(/DDP_DEFAULT_CONNECTION_URL hostname is 'build'/)
                .and.to.match(/meteor-desktop or rspack watcher/);
        });

        it("throws when DDP_DEFAULT_CONNECTION_URL hostname is 'build' even when ddpUrl is null (absence-is-OK is not poison-is-OK)", () => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a26-'));
            const indexPath = writeIndexWithRuntimeConfig(dir, {
                ROOT_URL: 'http://localhost:3000/',
                DDP_DEFAULT_CONNECTION_URL: 'http://build/'
            });
            const instance = buildInstance(indexPath, null);
            expect(() => instance.validateRuntimeConfigUrls())
                .to.throw(/DDP_DEFAULT_CONNECTION_URL hostname is 'build'/)
                .and.to.match(/meteor-desktop or rspack watcher/);
        });

        it('throws and suppresses the watcher hint when ROOT_URL differs from configured ddpUrl (mismatch != contention)', () => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a26-'));
            const indexPath = writeIndexWithRuntimeConfig(dir, {
                ROOT_URL: 'http://127.0.0.1:4000/',
                DDP_DEFAULT_CONNECTION_URL: 'http://127.0.0.1:4000/'
            });
            const instance = buildInstance(indexPath, 'http://127.0.0.1:3000');
            const err = expect(() => instance.validateRuntimeConfigUrls())
                .to.throw(/does not match configured --ddpUrl=http:\/\/127\.0\.0\.1:3000\//);
            err.and.to.not.match(/meteor-desktop or rspack watcher/);
        });

        it('throws when ddpUrl is set but DDP_DEFAULT_CONNECTION_URL is absent (production-path post-condition of updateDdpUrl)', () => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a26-'));
            const indexPath = writeIndexWithRuntimeConfig(dir, {
                ROOT_URL: 'http://127.0.0.1:3000/'
            });
            const instance = buildInstance(indexPath, 'http://127.0.0.1:3000');
            const err = expect(() => instance.validateRuntimeConfigUrls())
                .to.throw(/DDP_DEFAULT_CONNECTION_URL is missing or empty \(expected http:\/\/127\.0\.0\.1:3000\/ via --ddpUrl\)/);
            err.and.to.not.match(/meteor-desktop or rspack watcher/);
        });

        it('throws when ROOT_URL is absent entirely (structurally required, no watcher hint)', () => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a26-'));
            const indexPath = writeIndexWithRuntimeConfig(dir, {
                DDP_DEFAULT_CONNECTION_URL: 'http://127.0.0.1:3000/'
            });
            const instance = buildInstance(indexPath, null);
            const err = expect(() => instance.validateRuntimeConfigUrls())
                .to.throw(/ROOT_URL is missing or empty/);
            err.and.to.not.match(/meteor-desktop or rspack watcher/);
        });

        it('throws when __meteor_runtime_config__ block is absent', () => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-desktop-a26-'));
            const indexPath = path.join(dir, 'index.html');
            fs.writeFileSync(indexPath, '<html><head></head><body>no runtime config here</body></html>');
            const instance = buildInstance(indexPath, 'http://127.0.0.1:3000');
            expect(() => instance.validateRuntimeConfigUrls())
                .to.throw(/A2\.6: __meteor_runtime_config__ not found/);
        });
    });
});
