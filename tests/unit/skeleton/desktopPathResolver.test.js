/* eslint-disable global-require */
import * as chai from 'chai';
import dirty from 'dirty-chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

chai.use(sinonChai);
chai.use(dirty);

const {
    describe, it, before
} = global;
const { expect } = chai;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let DesktopPathResolver;

describe('DesktopPathResolver', () => {
    before(() => {
        DesktopPathResolver = require('../../../skeleton/desktopPathResolver.js').default;
    });

    describe('#resolveDesktopPath', () => {
        it('should always return the embedded desktop.asar path', () => {
            const infoStub = sinon.spy();
            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: infoStub });

            expect(infoStub).to.be.calledWithMatch('using embedded desktop.asar');
            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });

        it('should return embedded path regardless of userDataDir value', () => {
            const infoStub = sinon.spy();
            const desktopPath = DesktopPathResolver
                .resolveDesktopPath('/tmp/some-user-data', { info: infoStub });

            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
            // Should NOT contain the userDataDir in the path
            expect(desktopPath).to.not.include('/tmp/some-user-data');
        });
    });
});
