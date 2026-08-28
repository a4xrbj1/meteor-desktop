import * as chai from 'chai';
import path from 'path';

import MeteorServer from '../helpers/autoupdate/meteorServer.js';
import paths from '../helpers/paths.js';

const { describe, it } = global;
const { expect } = chai;

/**
 * Records what the server logs, in the shape the helper's own JSDoc promises.
 *
 * @returns {Object} - Logger with an `entries` array.
 */
const recordingLogger = () => {
    const entries = [];
    return {
        entries,
        info(...args) {
            entries.push(args.join(' '));
        },
        error(...args) {
            entries.push(args.join(' '));
        }
    };
};

describe('meteorServer test helper (seed meteor-desktop-c1f9)', () => {
    // The constructor had lost the `log` parameter its own JSDoc still documented, while init()
    // kept calling this.log.info in the parent-bundle branch — so that branch would have thrown
    // TypeError the first time a test used it. It never did, which is exactly why the drift
    // survived: the suite was green and tsc was silenced with @ts-expect-error.
    it('serves a parent bundle path without throwing, and logs it', async () => {
        const log = recordingLogger();
        const server = new MeteorServer(log);
        // The startup callbacks are awaited rather than ignored. this.log.info runs synchronously
        // inside init(), before startHttpServer, so asserting on the log alone would pass even when
        // the bind later failed — an EADDRINUSE on the hardcoded port 3788 would have made this
        // silently green while serving nothing, which is the opposite of what the name claims.
        const listening = new Promise((resolve, reject) => {
            server.setCallbacks(reject, resolve, resolve);
        });

        try {
            server.init(
                path.join(paths.fixtures.downloadableVersions, 'version3'),
                path.join(paths.fixtures.downloadableVersions, 'version2'),
                false
            );
            await listening;
        } finally {
            if (server.httpServerInstance) {
                /** @type {any} */ (server.httpServerInstance).destroy();
            }
        }

        expect(log.entries.join('\n')).to.contain('version2');
    });
});
