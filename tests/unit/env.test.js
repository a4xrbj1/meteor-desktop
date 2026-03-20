/* eslint-disable import-x/extensions */
import * as chai from 'chai';
import path from 'path';

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

    it('should default build paths to .meteor/local', () => {
        delete process.env.METEOR_LOCAL_DIR;

        const instance = new Env('/tmp/sample-app', null, {});

        expect(instance.paths.meteorApp.localDir).to.equal('/tmp/sample-app/.meteor/local');
        expect(instance.paths.meteorApp.webBrowser).to.equal('/tmp/sample-app/.meteor/local/build/programs/web.browser');
        expect(instance.paths.cache).to.equal('/tmp/sample-app/.meteor/local/desktop-cache');
    });

    it('should honor METEOR_LOCAL_DIR for build paths', () => {
        process.env.METEOR_LOCAL_DIR = '.meteor/local-start';

        const instance = new Env('/tmp/sample-app', null, {});

        expect(instance.paths.meteorApp.localDir).to.equal('/tmp/sample-app/.meteor/local-start');
        expect(instance.paths.meteorApp.webBrowser).to.equal('/tmp/sample-app/.meteor/local-start/build/programs/web.browser');
        expect(instance.paths.cache).to.equal('/tmp/sample-app/.meteor/local-start/desktop-cache');
    });

    it('should preserve absolute METEOR_LOCAL_DIR values', () => {
        process.env.METEOR_LOCAL_DIR = path.join('/tmp', 'shared-meteor-local');

        const instance = new Env('/tmp/sample-app', null, {});

        expect(instance.paths.meteorApp.localDir).to.equal('/tmp/shared-meteor-local');
        expect(instance.paths.meteorApp.webBrowser).to.equal('/tmp/shared-meteor-local/build/programs/web.browser');
        expect(instance.paths.cache).to.equal('/tmp/shared-meteor-local/desktop-cache');
    });
});