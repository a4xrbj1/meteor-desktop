/* eslint-disable import/extensions, import/no-extraneous-dependencies, global-require */
import * as chai from 'chai';
import dirty from 'dirty-chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import fs from 'fs';

chai.use(sinonChai);
chai.use(dirty);
const {
    describe, it, after, before
} = global;
const { expect } = chai;

const METEOR_APP_CONTEXT = { env: { paths: { meteorApp: { root: 'root.path', packages: 'package.file', versions: 'version.file' } } } };

let MeteorManager;
let readFileSyncStub;

describe('meteorManager', () => {
    before(async () => {
        MeteorManager = (await import('../../lib/meteorManager.js')).default;
    });

    after(() => {
        if (readFileSyncStub) {
            readFileSyncStub.restore();
        }
    });

    function prepareFsStubs() {
        if (readFileSyncStub) {
            readFileSyncStub.restore();
        }
        readFileSyncStub = sinon.stub(fs, 'readFileSync');
        readFileSyncStub
            .withArgs(sinon.match(METEOR_APP_CONTEXT.env.paths.meteorApp.packages, 'UTF-8'))
            .returns([
                '# Comment in file',
                'meteor-base@1.1.0',
                'mongo@1.1.18                   # Package name with comment',
                '# es5-shim@4.6.15                # Commented package',
                'omega:meteor-desktop-localstorage@=0.0.11'
            ].join('\n'));
        readFileSyncStub
            .withArgs(sinon.match(METEOR_APP_CONTEXT.env.paths.meteorApp.versions, 'UTF-8'))
            .returns([
                'meteor-base@1.1.0',
                'mongo@1.1.18',
                'omega:meteor-desktop-localstorage@0.0.11'
            ].join('\n'));
    }

    describe('#checkPackages', () => {
        let instance;

        before(() => {
            instance = new MeteorManager(METEOR_APP_CONTEXT);
            prepareFsStubs();
        });

        it('should find package in project', () => {
            expect(
                instance.checkPackages(['omega:meteor-desktop-localstorage@=0.0.11'])
            ).to.be.true();
        });

        it('should find package in project without specific versions', () => {
            expect(
                instance.checkPackages(['omega:meteor-desktop-localstorage'])
            ).to.be.true();
        });

        it('should not find commented package in project', () => {
            expect(
                instance.checkPackages(['es5-shim'])
            ).to.be.false();
        });
    });

    describe('#checkPackagesVersion', () => {
        let instance;

        before(() => {
            instance = new MeteorManager(METEOR_APP_CONTEXT);
            prepareFsStubs();
        });

        it('should find package in project with specific versions', () => {
            expect(
                instance.checkPackagesVersion(['omega:meteor-desktop-localstorage@0.0.11'])
            ).to.be.true();
        });

        it('should not find package in project without specific versions', () => {
            expect(
                instance.checkPackagesVersion(['omega:meteor-desktop-localstorage'])
            ).to.be.false();
        });

        it('should not find one package from list in project', () => {
            expect(
                instance.checkPackagesVersion([
                    'omega:meteor-desktop-localstorage@0.0.11',
                    'communitypackages:meteor-desktop-watcher@0.0.11'
                ])
            ).to.be.false();
        });
    });
});
