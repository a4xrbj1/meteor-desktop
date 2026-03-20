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
    describe, it, before, after
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
            .withArgs(sinon.match('release.file'), 'UTF-8')
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
});
