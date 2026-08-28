import * as chai from 'chai';

import meteorDesktop from '../../lib/index.js';

const { describe, it } = global;
const { expect } = chai;

describe('index justRun', () => {
    it('awaits electron.init() before electron.run() (seed meteor-desktop-86d2)', async () => {
        const md = meteorDesktop(
            '/tmp/sample-app',
            '/tmp/sample-app',
            { skipMobileBuild: true, output: '/tmp/sample-app' }
        );
        let initialised = false;
        let ranAfterInit = null;
        /** @type {any} */ (md).electron = {
            init: async () => {
                await new Promise((resolve) => { setImmediate(resolve); });
                initialised = true;
            },
            run: () => {
                ranAfterInit = initialised;
            }
        };

        await md.justRun();

        expect(ranAfterInit).to.equal(true);
    });
});
