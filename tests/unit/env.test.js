/* eslint-disable import-x/extensions */
import * as chai from 'chai';

const { describe, it, afterEach } = global;
const { expect } = chai;

let Env;

describe('env', () => {
    const originalMeteorLocalDir = process.env.METEOR_LOCAL_DIR;

    afterEach(() => {
        if (originalMeteorLocalDir === undefined) {
            delete process.env.METEOR_LOCAL_DIR;
        } else {
            process.env.METEOR_LOCAL_DIR = originalMeteorLocalDir;
        }
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
});
