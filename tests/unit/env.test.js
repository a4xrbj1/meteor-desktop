/* eslint-disable import-x/extensions */
import * as chai from 'chai';

const { describe, it, afterEach } = global;
const { expect } = chai;

let Env;

describe('env', () => {
    const originalMeteorLocalDir = process.env.METEOR_LOCAL_DIR;
    const originalRspackEnv = {
        RSPACK_BUILD_CONTEXT: process.env.RSPACK_BUILD_CONTEXT,
        RSPACK_CHUNKS_CONTEXT: process.env.RSPACK_CHUNKS_CONTEXT,
        RSPACK_ASSETS_CONTEXT: process.env.RSPACK_ASSETS_CONTEXT
    };

    afterEach(() => {
        if (originalMeteorLocalDir === undefined) {
            delete process.env.METEOR_LOCAL_DIR;
        } else {
            process.env.METEOR_LOCAL_DIR = originalMeteorLocalDir;
        }
        Object.entries(originalRspackEnv).forEach(([key, value]) => {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        });
    });

    before(async () => {
        Env = (await import('../../lib/env.js')).default;
    });

    it('should default build paths to .meteor/local in dev mode', () => {
        delete process.env.METEOR_LOCAL_DIR;

        const instance = new Env('/tmp/sample-app', null, { skipMobileBuild: true });

        expect(instance.paths.meteorApp.localDir).to.equal('/tmp/sample-app/.meteor/local');
        expect(instance.paths.meteorApp.webBrowser).to.equal('/tmp/sample-app/.meteor/local/build/programs/web.browser');
        expect(instance.paths.cache).to.equal('/tmp/sample-app/.meteor/local/desktop-cache');
    });

    it('should use .meteor/local-desktop in production build mode', () => {
        delete process.env.METEOR_LOCAL_DIR;

        const instance = new Env('/tmp/sample-app', null, {});

        expect(instance.paths.meteorApp.localDir).to.equal('/tmp/sample-app/.meteor/local-desktop');
        expect(instance.paths.meteorApp.webBrowser).to.equal('/tmp/sample-app/.meteor/local-desktop/build/programs/web.browser');
        expect(instance.paths.cache).to.equal('/tmp/sample-app/.meteor/local-desktop/desktop-cache');
    });

    it('should set METEOR_LOCAL_DIR env var in production build mode', () => {
        delete process.env.METEOR_LOCAL_DIR;

        // eslint-disable-next-line no-unused-vars
        const instance = new Env('/tmp/sample-app', null, {});

        expect(process.env.METEOR_LOCAL_DIR).to.equal('.meteor/local-desktop');
    });

    it('should derive @meteorjs/rspack@^2.x context names from METEOR_LOCAL_DIR=.meteor/local-desktop in prod', () => {
        delete process.env.METEOR_LOCAL_DIR;

        const instance = new Env('/tmp/sample-app', null, {});

        expect(instance.paths.meteorApp.rspack.buildContext).to.equal('_build-local-desktop');
        expect(instance.paths.meteorApp.rspack.chunksContext).to.equal('build-chunks-local-desktop');
        expect(instance.paths.meteorApp.rspack.assetsContext).to.equal('build-assets-local-desktop');
        expect(instance.paths.meteorApp.rspack.buildDir).to.equal('/tmp/sample-app/_build-local-desktop');
    });

    it('should default to .meteor/local basename in dev mode when METEOR_LOCAL_DIR is unset', () => {
        delete process.env.METEOR_LOCAL_DIR;

        const instance = new Env('/tmp/sample-app', null, { skipMobileBuild: true });

        expect(instance.paths.meteorApp.rspack.buildContext).to.equal('_build-local');
        expect(instance.paths.meteorApp.rspack.chunksContext).to.equal('build-chunks-local');
        expect(instance.paths.meteorApp.rspack.assetsContext).to.equal('build-assets-local');
    });

    it('should honor RSPACK_BUILD_CONTEXT env var override', () => {
        delete process.env.METEOR_LOCAL_DIR;
        process.env.RSPACK_BUILD_CONTEXT = 'custom-build';

        const instance = new Env('/tmp/sample-app', null, {});

        expect(instance.paths.meteorApp.rspack.buildContext).to.equal('custom-build');
        // chunks/assets unaffected by RSPACK_BUILD_CONTEXT
        expect(instance.paths.meteorApp.rspack.chunksContext).to.equal('build-chunks-local-desktop');
        expect(instance.paths.meteorApp.rspack.buildDir).to.equal('/tmp/sample-app/custom-build');
    });

    it('should honor an inherited METEOR_LOCAL_DIR over the dev-mode default basename', () => {
        process.env.METEOR_LOCAL_DIR = '/some/wrapper/local-custom';

        const instance = new Env('/tmp/sample-app', null, { skipMobileBuild: true });

        expect(instance.paths.meteorApp.rspack.buildContext).to.equal('_build-local-custom');
        expect(instance.paths.meteorApp.rspack.chunksContext).to.equal('build-chunks-local-custom');
    });
});
