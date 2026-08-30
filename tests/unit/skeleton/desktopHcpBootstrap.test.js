import * as chai from 'chai';
import dirty from 'dirty-chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import vm from 'vm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

chai.use(sinonChai);
chai.use(dirty);

const {
    describe, it, beforeEach
} = global;
const { expect } = chai;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hcpSource = fs.readFileSync(
    path.join(__dirname, '../../../skeleton/desktop-hcp.js'), 'utf8'
);

// Loads the REAL desktop-hcp.js (a classic renderer script, not a module) in a
// vm sandbox with the renderer globals it expects, so we exercise the actual
// G1 bootstrap wiring (seed meteor-desktop-e490) rather than a reimplementation.
const loadInSandbox = (overrides = {}) => {
    const reload = { _reload: sinon.spy() };
    const sandbox = /** @type {any} */ ({
        Desktop: { send: sinon.spy(), on: sinon.spy() },
        Meteor: { startup: (cb) => cb() },
        window: { Package: { reload: { Reload: reload } } },
        console: { log: sinon.spy(), warn: sinon.spy() },
        setTimeout: sinon.spy(),
        setInterval: sinon.spy(),
        // A fresh vm context gets ECMAScript intrinsics only — `URL` is a Node/Web global and is
        // NOT among them, so without this the loopback gate's URL parse throws, is caught, and
        // fails open. Chromium always has it; hand the sandbox the real one rather than a stub.
        URL,
        ...overrides
    });
    sandbox.globalThis = sandbox;
    vm.runInNewContext(hcpSource, sandbox);
    return { sandbox, reload };
};

describe('desktop-hcp.js web HCP bridge bootstrap', () => {
    let result;
    beforeEach(() => {
        result = loadInSandbox();
    });

    it('defines the WebAppLocalServer bridge with the expected methods', () => {
        const { sandbox } = result;
        expect(sandbox.WebAppLocalServer).to.be.an('object');
        ['checkForUpdates', 'onNewVersionReady', 'startupDidComplete', 'onError']
            .forEach((m) => expect(sandbox.WebAppLocalServer[m]).to.be.a('function'));
    });

    it('asks the desktop side to check for updates once Meteor has started', () => {
        const { sandbox } = result;
        // requestCheck() → WebAppLocalServer.checkForUpdates() → Desktop.send(...)
        expect(sandbox.Desktop.send).to.have.been.calledWith('autoupdate', 'checkForUpdates');
    });

    it('schedules a periodic re-check', () => {
        expect(result.sandbox.setInterval).to.have.been.called();
    });

    // seed e2e-5c54. A loopback ROOT_URL is a dev `meteor run` or the e2e harness, where the
    // served bundle can never match the packaged one, so every automatic check downloads a bundle
    // verifyRuntimeConfig then refuses. The default sandbox above has no __meteor_runtime_config__
    // at all, which is why the two tests above still see a check — absence must fail OPEN.
    ['http://localhost:3000/', 'http://127.0.0.1:3000/', 'http://[::1]:3000/'].forEach((rootUrl) => {
        it(`does not start automatic update checks against a loopback ROOT_URL (${rootUrl})`, () => {
            const { sandbox } = loadInSandbox({
                window: {
                    Package: { reload: { Reload: { _reload: sinon.spy() } } },
                    __meteor_runtime_config__: { ROOT_URL: rootUrl }
                }
            });
            expect(sandbox.Desktop.send).to.not.have.been.calledWith('autoupdate', 'checkForUpdates');
            expect(sandbox.setInterval).to.not.have.been.called();
            // The three registrations ahead of the gate must still have run — skipping
            // startupDidComplete() is the stuck-splash brick (seed meteor-desktop-hcp-brick).
            expect(sandbox.Desktop.send).to.have.been.calledWith('autoupdate', 'startupDidComplete');
            expect(sandbox.WebAppLocalServer.onErrorCallback).to.be.a('function');
            expect(sandbox.WebAppLocalServer.onNewVersionReadyCallback).to.be.a('function');
        });
    });

    it('still checks against a real (non-loopback) ROOT_URL — prod is unaffected', () => {
        const { sandbox } = loadInSandbox({
            window: {
                Package: { reload: { Reload: { _reload: sinon.spy() } } },
                __meteor_runtime_config__: { ROOT_URL: 'https://app.yourdna.family/' }
            }
        });
        expect(sandbox.Desktop.send).to.have.been.calledWith('autoupdate', 'checkForUpdates');
        expect(sandbox.setInterval).to.have.been.called();
    });

    it('leaves checkForUpdates() callable under the loopback gate (e2e-5c54: the harness drives it directly)', () => {
        const { sandbox } = loadInSandbox({
            window: {
                Package: { reload: { Reload: { _reload: sinon.spy() } } },
                __meteor_runtime_config__: { ROOT_URL: 'http://127.0.0.1:3000/' }
            }
        });
        expect(sandbox.Desktop.send).to.not.have.been.calledWith('autoupdate', 'checkForUpdates');
        sandbox.WebAppLocalServer.checkForUpdates();
        expect(sandbox.Desktop.send).to.have.been.calledWith('autoupdate', 'checkForUpdates');
    });

    it('routes a staged bundle through Meteor Reload (apply via existing gate)', () => {
        const { sandbox, reload } = result;
        // Simulate the native side reporting a verified, staged bundle.
        sandbox.WebAppLocalServer.onNewVersionReadyCallback('7e3c0186');
        expect(reload._reload).to.have.been.calledOnce();
    });

    it('does not start until Meteor is available (defers via setTimeout)', () => {
        const setTimeoutSpy = sinon.spy();
        const { sandbox } = loadInSandbox({ Meteor: undefined, setTimeout: setTimeoutSpy });
        // No Meteor → no checkForUpdates yet, and a retry was scheduled.
        expect(sandbox.Desktop.send).to.not.have.been.calledWith('autoupdate', 'checkForUpdates');
        expect(setTimeoutSpy).to.have.been.called();
    });

    it('surfaces an autoupdate error that fires before the error sink is registered, without throwing (e2e-2589)', () => {
        // Reproduce the exact race: Meteor.startup captured but NOT run, so start() never executes
        // and the error sink (WebAppLocalServer.onError) is never registered — onErrorCallback stays
        // null, the window that made the unguarded bridge call null(args) → "onErrorCallback is not a
        // function" (intermittent under full-suite load, where startup is delayed). Inversion check:
        // without the null guard this errorHandler call throws and the test fails.
        const { sandbox } = loadInSandbox({ Meteor: { startup: sinon.spy() } });
        expect(sandbox.WebAppLocalServer.onErrorCallback).to.equal(null);
        const errorCall = sandbox.Desktop.on.getCalls().find(
            (c) => c.args[0] === 'autoupdate' && c.args[1] === 'error'
        );
        expect(errorCall, 'an autoupdate error bridge handler is registered at module load').to.exist();
        const errorHandler = errorCall.args[2];
        expect(() => errorHandler({}, 'HCP boom')).to.not.throw();
        expect(sandbox.console.warn).to.have.been.calledWith(
            '[meteor-desktop] autoupdate error before error sink registered:', 'HCP boom'
        );
    });
});
