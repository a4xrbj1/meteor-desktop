import * as chai from 'chai';
import dirty from 'dirty-chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import { createRequire } from 'module';

import moduleMock from '../../helpers/moduleMock.js';

chai.use(sinonChai);
chai.use(dirty);
const {
    describe,
    it,
    before,
    after
} = global;
const { expect } = chai;
const require = createRequire(import.meta.url);

const Electron = { protocol: { registerStandardSchemes: Function.prototype } };

let App;

const fs = {};

describe('App', () => {
    before(() => {
        moduleMock.registerMock('electron', Electron);
        moduleMock.registerMock('./desktopPathResolver', {});
        moduleMock.registerMock('fs-plus', fs);
        moduleMock.enable();
        process.env.METEOR_DESKTOP_UNIT_TEST = 'true';
        App = require('../../../skeleton/app.js');
        App = App.default;
        // We will get a transpiled version here with a babel function upfront.
        // The code below injects empty constructor and restores the prototype which effectively
        // will allow us to invoke it with `new` and do what we want without calling the internal
        // babel functions.
        const oldProto = App.prototype;
        App = function App() {}; // eslint-disable-line
        App.prototype = oldProto;
    });

    after(() => {
        process.env.METEOR_DESKTOP_UNIT_TEST = 'false';
        moduleMock.deregisterMock('./desktopPathResolver');
        moduleMock.deregisterMock('fs-plus');
        moduleMock.deregisterMock('electron');
        moduleMock.disable();
    });

    describe('#emitAsync', () => {
        it('should resolve when having synchronous handlers', () => {
            const stub1 = sinon.stub();
            const stub2 = sinon.stub();
            const app = new App();
            app.eventsBus = {
                listeners: (eventName) => ((eventName === 'event') ? [stub1, stub2] : [])
            };
            return new Promise((resolve, reject) => {
                app.emitAsync('event', 'test', 12345)
                    .then(() => {
                        expect(stub1).to.have.been.calledOnce();
                        expect(stub1).to.have.been.calledWith(sinon.match('test'), sinon.match(12345));
                        expect(stub2).to.have.been.calledOnce();
                        expect(stub2).to.have.been.calledWith(sinon.match('test'), sinon.match(12345));
                        resolve();
                    })
                    .catch((err) => {
                        reject(err);
                    });
            });
        });

        it('should resolve with values from promise', () => {
            const app = new App();
            const stub = sinon.stub();
            stub.resolves('test');
            const stub2 = sinon.stub();
            stub2.resolves('test2');
            app.eventsBus = {
                listeners: (eventName) => ((eventName === 'event') ? [stub, stub2] : [])
            };
            return new Promise((resolve, reject) => {
                app.emitAsync('event', 'test', 12345)
                    .then((result) => {
                        expect(stub).to.have.been.calledOnce();
                        expect(stub).to.have.been.calledWith(sinon.match('test'), sinon.match(12345));
                        expect(result).to.deep.equal(['test', 'test2']);
                        resolve();
                    })
                    .catch((err) => {
                        reject(err);
                    });
            });
        });

        it('should reject with rejection value from failing handler', () => {
            const app = new App();
            const stub = sinon.stub();
            stub.rejects(new Error('reject'));
            const stub2 = sinon.stub();
            stub2.resolves('test2');
            app.eventsBus = {
                listeners: (eventName) => ((eventName === 'event') ? [stub, stub2] : [])
            };
            return new Promise((resolve, reject) => {
                app.emitAsync('event', 'test', 12345)
                    .then(() => {
                        reject('should not be resolved');
                    })
                    .catch((err) => {
                        expect(err.message).to.equal('reject');
                        resolve();
                    });
            });
        });

        it('should reject with throw value', () => {
            const app = new App();
            const stub = sinon.stub();
            stub.throws(new Error('reject'));
            app.eventsBus = {
                listeners: (eventName) => ((eventName === 'event') ? [stub] : [])
            };
            app.l = { error: Function.prototype };
            return new Promise((resolve, reject) => {
                app.emitAsync('event', 'test', 12345)
                    .then(() => {
                        reject('should not be resolved');
                    })
                    .catch((err) => {
                        expect(err.message).to.equal('reject');
                        resolve();
                    });
            });
        });
    });

    describe('#injectRspackClientScript', () => {
        it('should inject the Rspack client bundle into Cordova HTML when missing', () => {
            const app = new App();
            const html = '<html><head><link href="/build-chunks/main.css" rel="stylesheet"></head><body><script src="/app.js"></script></body></html>'; // eslint-disable-line @stylistic/max-len

            const patchedHtml = app.injectRspackClientScript(html);

            expect(patchedHtml).to.include('/__rspack__/client-rspack.js');
            expect((patchedHtml.match(/__rspack__\/client-rspack\.js/g) || []).length).to.equal(1);
            expect(patchedHtml.indexOf('/app.js')).to.be.below(patchedHtml.indexOf('/__rspack__/client-rspack.js'));
        });

        it('should append the Rspack client bundle when the html has no closing body tag', () => {
            const app = new App();
            const html = '<html><head><link href="/build-chunks/main.css" rel="stylesheet"></head><script src="/app.js"></script>';

            const patchedHtml = app.injectRspackClientScript(html);

            expect(patchedHtml).to.equal(`${html}<script src="/__rspack__/client-rspack.js"></script>`);
        });

        it('should leave HTML unchanged when the Rspack client bundle is already present', () => {
            const app = new App();
            const html = '<html><head><link href="/build-chunks/main.css" rel="stylesheet"></head><body><script src="/app.js"></script><script src="/__rspack__/client-rspack.js"></script></body></html>'; // eslint-disable-line @stylistic/max-len

            const patchedHtml = app.injectRspackClientScript(html);

            expect(patchedHtml).to.equal(html);
        });

        it('should leave HTML unchanged when no Rspack assets are present', () => {
            const app = new App();
            const html = '<html><head></head><body><script src="/app.js"></script></body></html>';

            const patchedHtml = app.injectRspackClientScript(html);

            expect(patchedHtml).to.equal(html);
        });

        it('should inject the Rspack client bundle when only a v2.x suffixed chunk URL is present', () => {
            // Under METEOR_LOCAL_DIR=.meteor/local-desktop rspack 2.x emits
            // /build-chunks-local-desktop/*. Without the dynamic-suffix regex
            // the v6.0.6 literal /build-chunks/ guard would early-return here
            // and silently skip the <script src="/__rspack__/client-rspack.js"> tag.
            const app = new App();
            const html = '<html><head>'
                + '<link href="/build-chunks-local-desktop/main.css" rel="stylesheet">'
                + '</head><body><script src="/app.js"></script></body></html>';

            const patchedHtml = app.injectRspackClientScript(html);

            expect(patchedHtml).to.include('/__rspack__/client-rspack.js');
            expect(patchedHtml.indexOf('/app.js'))
                .to.be.below(patchedHtml.indexOf('/__rspack__/client-rspack.js'));
        });
    });

    describe('#prepareAutoupdateSettings', () => {
        it('should use defaults when optional autoupdate settings are absent', () => {
            const app = new App();
            app.userDataDir = '/tmp/meteor-desktop-user-data';
            app.settings = {};
            app.resolveInitialBundlePath = sinon.stub().returns('/tmp/bootstrap/meteor');

            const autoupdateSettings = app.prepareAutoupdateSettings();

            expect(autoupdateSettings).to.deep.equal({
                dataPath: '/tmp/meteor-desktop-user-data',
                bundleStorePath: '/tmp/meteor-desktop-user-data',
                customHCPUrl: null,
                initialBundlePath: '/tmp/bootstrap/meteor',
                webAppStartupTimeout: 20000
            });
        });

        it('should pass through configured autoupdate overrides', () => {
            const app = new App();
            app.userDataDir = '/tmp/meteor-desktop-user-data';
            app.settings = {
                customHCPUrl: 'https://updates.example.com/__cordova/',
                webAppStartupTimeout: 45000
            };
            app.resolveInitialBundlePath = sinon.stub().returns('/tmp/bootstrap/meteor.asar');

            const autoupdateSettings = app.prepareAutoupdateSettings();

            expect(autoupdateSettings.customHCPUrl).to.equal('https://updates.example.com/__cordova/');
            expect(autoupdateSettings.initialBundlePath).to.equal('/tmp/bootstrap/meteor.asar');
            expect(autoupdateSettings.webAppStartupTimeout).to.equal(45000);
        });
    });

    describe('#handleAppStartup', () => {
        /**
         * Builds a bare App with just the fields handleAppStartup touches.
         *
         * @param {Object|null} window - The BrowserWindow stand-in, or null for a torn-down window.
         *
         * @returns {Object} The app instance.
         */
        const buildApp = (window) => {
            const app = new App();
            app.settings = {};
            app.l = {
                info: sinon.stub(), debug: sinon.stub(), warn: sinon.stub(), verbose: sinon.stub()
            };
            app.startup = false;
            app.windowAlreadyLoaded = false;
            app.meteorAppVersionChange = false;
            app.window = window;
            app.emit = sinon.stub();
            app.updateToNewVersion = sinon.stub();
            return app;
        };

        // ESC-0005 regression. A win32 5.2.2 user's startup watchdog gave up and called
        // app.exit(0); 1.18s later the renderer finally reached Meteor.startup and its
        // startupDidComplete IPC landed in a main process whose window was already destroyed and
        // whose `closed` handler had nulled this.window. handleAppStartup then dereferenced it:
        // "TypeError: Cannot read properties of null (reading 'show')", crashing the main process.
        // Inversion check: delete the `if (!this.window)` guard in skeleton/app.js and this test
        // fails with exactly that TypeError. If it still passes, the guard is not covered.
        it('should not throw when the window was torn down before a late startupDidComplete', () => {
            const app = buildApp(null);
            expect(() => app.handleAppStartup(true)).to.not.throw();
            expect(app.l.warn).to.have.been.calledOnce();
            // Nothing downstream may run either: updateToNewVersion would restart the local HTTP
            // server while the app is quitting.
            expect(app.emit).to.have.not.been.called();
            expect(app.updateToNewVersion).to.have.not.been.called();
        });

        it('should not throw on a late did-stop-loading either', () => {
            // The other producer of this call (webContents did-stop-loading) reaches the same
            // dereference, so the guard has to cover both entry points, not just the IPC.
            const app = buildApp(null);
            expect(() => app.handleAppStartup(false)).to.not.throw();
        });

        // The guard's counterpart: it must not over-block. Without this, deleting the whole body
        // of handleAppStartup would still pass the tests above.
        it('should still show the window on a normal startup', () => {
            const show = sinon.stub();
            const focus = sinon.stub();
            const app = buildApp({ show, focus });

            app.handleAppStartup(true);

            expect(show).to.have.been.calledOnce();
            expect(focus).to.have.been.calledOnce();
            expect(app.windowAlreadyLoaded).to.be.true();
            expect(app.emit).to.have.been.calledWith('loadingFinished');
        });
    });
});
