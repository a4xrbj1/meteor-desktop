/* eslint-disable global-require */
import * as chai from 'chai';
import dirty from 'dirty-chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

chai.use(sinonChai);
chai.use(dirty);

const {
    describe, it, after, before
} = global;
const { expect } = chai;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let DesktopPathResolver;
let readFileSyncStub;

describe('DesktopPathResolver', () => {
    before(() => {
        DesktopPathResolver = require('../../../skeleton/desktopPathResolver.js').default;
    });

    after(() => {
        if (readFileSyncStub) {
            readFileSyncStub.restore();
        }
    });

    describe('#resolveDesktopPath', () => {
        function prepareFsStubs(desktopVersion, initialMeteorVersion, autoUpdateJson, indexHtml = '<html>initial</html>') {
            if (readFileSyncStub) {
                readFileSyncStub.restore();
            }
            readFileSyncStub = sinon.stub(fs, 'readFileSync');
            // initial desktop version
            readFileSyncStub
                .withArgs(sinon.match('desktop.asar').and(sinon.match('settings.json')))
                .returns(JSON.stringify({ desktopVersion }));
            // initial meteor version (matches both meteor.asar/program.json and meteor/program.json)
            readFileSyncStub
                .withArgs(sinon.match('meteor').and(sinon.match('program.json')))
                .returns(JSON.stringify({ version: initialMeteorVersion }));
            readFileSyncStub
                .withArgs(sinon.match('meteor').and(sinon.match('index.html')))
                .returns(indexHtml);
            // autoupdate.json
            readFileSyncStub
                .withArgs(sinon.match('autoupdate.json'))
                .returns(JSON.stringify(autoUpdateJson));
        }

        it('should use initial version when meteor initial bundle version has changed', () => {
            prepareFsStubs(1, 2, {
                lastSeenInitialVersion: 1
            });
            const infoStub = sinon.spy();
            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, {
                    info: infoStub
                });
            expect(infoStub).to.be.calledWithMatch('will use desktop.asar from'
                + ' initial version because the initial version of meteor app has changed');
            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });

        it('should use initial version when no downloaded version is available', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastDownloadedVersion: null
            });
            const infoStub = sinon.spy();
            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: infoStub });
            expect(infoStub).to.be.calledWithMatch(
                sinon.match('using desktop.asar from initial bundle')
            );
            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });

        it('should use initial version when embedded bootstrap signature has changed', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastSeenInitialSignature: 'stale-signature',
                lastDownloadedVersion: '546',
                lastKnownGoodVersion: '546',
                blacklistedVersions: []
            }, '<html>fresh bootstrap</html>');

            const infoStub = sinon.spy();
            const desktopPath = DesktopPathResolver.resolveDesktopPath(__dirname, { info: infoStub });

            expect(infoStub).to.be.calledWithMatch(sinon.match(
                'will use desktop.asar from initial version because the embedded bootstrap '
                + 'signature of meteor app has changed'
            ));
            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });

        it('should use last known good version (if different than initial)', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastDownloadedVersion: '546',
                lastKnownGoodVersion: '546',
                blacklistedVersions: []
            });
            const infoStub = sinon.spy();
            readFileSyncStub
                .withArgs(sinon.match('546').and(sinon.match('_desktop.json')))
                .returns(JSON.stringify({ version: 897 }));

            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: infoStub });

            expect(infoStub.secondCall).to.be.calledWithMatch(sinon.match('will use desktop.asar'
                + ' from last downloaded version at'));

            expect(desktopPath.endsWith('897_desktop.asar')).to.be.true();
        });

        it('should use initial version if last downloaded is using it', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastDownloadedVersion: '546',
                lastKnownGoodVersion: '546',
                blacklistedVersions: []
            });
            const infoStub = sinon.spy();
            readFileSyncStub
                .withArgs(sinon.match('546').and(sinon.match('_desktop.json')))
                .returns(JSON.stringify({ version: 1 }));

            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: infoStub });

            expect(infoStub.secondCall).to.be.calledWithMatch(sinon.match(
                'will use desktop.asar from initial version because last downloaded version is '
                + 'using it'
            ));

            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });

        it('should use initial version if last downloaded does not have any', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastDownloadedVersion: '546',
                lastKnownGoodVersion: '546',
                blacklistedVersions: []
            });
            const infoStub = sinon.spy();
            readFileSyncStub
                .withArgs(sinon.match('546').and(sinon.match('_desktop.json')))
                .returns(JSON.stringify({}));

            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: infoStub });

            expect(infoStub.secondCall).to.be.calledWithMatch(sinon.match(
                'will use desktop.asar from initial version because last downloaded version does '
                + 'not contain new desktop version'
            ));

            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });

        it('should use initial version if last downloaded is equal to initial version', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastDownloadedVersion: 1,
                lastKnownGoodVersion: 1,
                blacklistedVersions: []
            });
            const infoStub = sinon.spy();
            readFileSyncStub
                .withArgs(sinon.match('546').and(sinon.match('_desktop.json')))
                .returns(JSON.stringify({}));

            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: infoStub });

            expect(infoStub.secondCall).to.be.calledWithMatch(sinon.match(
                'will use desktop.asar from last downloaded version which is '
                + 'apparently the initial bundle'
            ));

            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });

        it('should use last known good version if last downloaded is blacklisted', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastDownloadedVersion: '123',
                lastKnownGoodVersion: '120',
                blacklistedVersions: ['123']
            });

            const infoStub = sinon.spy();
            const warnStub = sinon.spy();

            readFileSyncStub
                .withArgs(sinon.match('120').and(sinon.match('_desktop.json')))
                .returns(JSON.stringify({ version: 897 }));

            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: infoStub, warn: warnStub });

            expect(warnStub.firstCall).to.be.calledWithMatch(sinon.match(
                'will use desktop.asar from last known good version'
            ));

            expect(desktopPath.endsWith('897_desktop.asar')).to.be.true();
        });

        it('should use initial version if last know good version is using it', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastDownloadedVersion: '123',
                lastKnownGoodVersion: '120',
                blacklistedVersions: ['123']
            });

            const infoStub = sinon.spy();
            const warnStub = sinon.spy();

            readFileSyncStub
                .withArgs(sinon.match('120').and(sinon.match('_desktop.json')))
                .returns(JSON.stringify({ version: 1 }));

            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: infoStub, warn: warnStub });

            expect(warnStub.firstCall).to.be.calledWithMatch(sinon.match(
                'will use desktop.asar from initial version because '
                + 'last known good version of meteor app is using it'
            ));

            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });

        it('should use initial version if last know good version does not have any', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastDownloadedVersion: '123',
                lastKnownGoodVersion: '120',
                blacklistedVersions: ['123']
            });

            const infoStub = sinon.spy();
            const warnStub = sinon.spy();

            readFileSyncStub
                .withArgs(sinon.match('120').and(sinon.match('_desktop.json')))
                .returns(JSON.stringify({}));

            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: infoStub, warn: warnStub });

            expect(warnStub.firstCall).to.be.calledWithMatch(sinon.match(
                'will use desktop.asar from initial version because last '
                + 'known good version of meteor app does not contain new desktop '
                + 'version'
            ));

            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });

        it('should use initial version if last know good version is using it', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastDownloadedVersion: '123',
                lastKnownGoodVersion: 1,
                blacklistedVersions: ['123']
            });

            const warnStub = sinon.spy();

            readFileSyncStub
                .withArgs(sinon.match('120').and(sinon.match('_desktop.json')))
                .returns(JSON.stringify({ version: 1 }));

            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: Function.prototype, warn: warnStub });

            expect(warnStub.firstCall).to.be.calledWithMatch(sinon.match(
                'will use desktop.asar from last known good version which is '
                + 'apparently the initial bundle'
            ));

            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });

        it('should use initial version when no last known good version is present', () => {
            prepareFsStubs(1, 1, {
                lastSeenInitialVersion: 1,
                lastDownloadedVersion: '123',
                blacklistedVersions: ['123']
            });

            const infoStub = sinon.spy();
            const warnStub = sinon.spy();

            readFileSyncStub
                .withArgs(sinon.match('120').and(sinon.match('_desktop.json')))
                .returns(JSON.stringify({ version: 1 }));

            const desktopPath = DesktopPathResolver
                .resolveDesktopPath(__dirname, { info: infoStub, warn: warnStub });

            expect(warnStub.firstCall).to.be.calledWithMatch(sinon.match(
                'will use desktop.asar from initial version as a fallback'
            ));

            expect(desktopPath.endsWith(`${path.sep}desktop.asar`)).to.be.true();
        });
    });
});
