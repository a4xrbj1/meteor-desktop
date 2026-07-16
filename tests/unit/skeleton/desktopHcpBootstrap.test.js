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
