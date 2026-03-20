/* eslint-disable no-underscore-dangle, global-require */
import * as chai from 'chai';
import dirty from 'dirty-chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import mockery from 'mockery';
import { createRequire } from 'module';

import mockerySettings from '../../helpers/mockerySettings.js';

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
const Winston = {};

let App;

const fs = {};

describe('App', () => {
    before(() => {
        mockery.registerMock('electron', Electron);
        mockery.registerMock('winston', Winston);
        mockery.registerMock('./desktopPathResolver', {});
        mockery.registerMock('fs-plus', fs);
        mockery.enable(mockerySettings);
        process.env.METEOR_DESKTOP_UNIT_TEST = true;
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
        process.env.METEOR_DESKTOP_UNIT_TEST = false;
        mockery.deregisterMock('./desktopPathResolver');
        mockery.deregisterMock('fs-plus');
        mockery.deregisterMock('electron');
        mockery.deregisterMock('winston');
        mockery.disable();
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
            const html = '<html><head><link href="/build-chunks/main.css" rel="stylesheet"></head><body><script src="/app.js"></script></body></html>';

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
            const html = '<html><head><link href="/build-chunks/main.css" rel="stylesheet"></head><body><script src="/app.js"></script><script src="/__rspack__/client-rspack.js"></script></body></html>';

            const patchedHtml = app.injectRspackClientScript(html);

            expect(patchedHtml).to.equal(html);
        });

        it('should leave HTML unchanged when no Rspack assets are present', () => {
            const app = new App();
            const html = '<html><head></head><body><script src="/app.js"></script></body></html>';

            const patchedHtml = app.injectRspackClientScript(html);

            expect(patchedHtml).to.equal(html);
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
                desktopBundlePath: '/tmp/meteor-desktop-user-data',
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
});
