import * as chai from 'chai';
import dirty from 'dirty-chai';
import path from 'path';
import { fileURLToPath } from 'url';

import { getFakeLogger } from '../meteorDesktop.js';
import AssetBundle from '../../../skeleton/modules/autoupdate/assetBundle.js';
import LocalServer from '../../../skeleton/modules/localServer.js';

chai.use(dirty);
const { expect } = chai;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let localServer;
let localServerPort;

/**
 * Runs a local server - the one which is serving the app to builtin chrome in Electron.
 *
 * @param mainPath
 * @param parentPath
 * @returns {Promise}
 */
export function setUpLocalServer(mainPath, parentPath) {
    let resolve;
    let reject;

    function onServerReady(port) {
        localServerPort = port;
        resolve(localServer);
    }

    const fakeLogger = getFakeLogger();
    let parentAssetBundle;

    if (parentPath) {
        parentAssetBundle = new AssetBundle(
            fakeLogger,
            parentPath
        );
    }

    const assetBundle = new AssetBundle(
        fakeLogger,
        mainPath,
        undefined,
        parentAssetBundle
    );

    if (!localServer) {
        return new Promise((promiseResolve, promiseReject) => {
            resolve = promiseResolve;
            reject = promiseReject;
            localServer = new LocalServer({
                log: {
                    warn: console.warn,
                    info: console.info,
                    debug: console.log,
                    error: console.error
                },
                skeletonApp: {
                    userDataDir: __dirname
                }
            });
            localServer.setCallbacks(() => reject(), onServerReady, onServerReady);
            localServer.init(assetBundle, '', false, false);
        });
    }
    return new Promise((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
        localServer.setCallbacks(() => reject(), onServerReady, onServerReady);
        localServer.init(assetBundle, '', true, false);
    });
}

/**
 * Fetches from the local server with retry logic to handle stale undici connections
 * after a server restart.
 * @param {string} url
 * @param {number} retries
 * @returns {Promise<Response>}
 */
export async function fetchFromLocalServer(url, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fetch(`http://127.0.0.1:${localServerPort}${url}`);
        } catch (e) {
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 100));
            } else {
                throw e;
            }
        }
    }
}

/**
 * Extracts and returns runtime config from index.html.
 * @param html
 */
function runtimeConfigFromHTML(html) {
    const regex = /__meteor_runtime_config__ = JSON.parse\(decodeURIComponent\("([^"]*)"\)\)/;
    const matches = html.match(regex);
    if (!matches) {
        throw new Error('Can\'t find __meteor_runtime_config__');
    }
    return JSON.parse(decodeURIComponent(matches[1]));
}

/**
 * Check for the expected version being served now from local server.
 * @param expectedVersion
 */
export async function expectVersionServedToEqual(expectedVersion) {
    const response = await fetchFromLocalServer('/');
    expect(response.status).to.equal(200);
    expect(response.headers.get('Content-Type')).to.contain('text/html');
    const body = await response.text();
    const config = runtimeConfigFromHTML(body);
    const version = config.autoupdateVersionCordova;
    expect(version).to.equal(expectedVersion);
}

export function shutdownLocalServer() {
    return new Promise((resolve) => {
        if (localServer && localServer.httpServerInstance) {
            localServer.httpServerInstance.destroy(() => {
                localServer = null;
                resolve();
            });
        } else {
            localServer = null;
            resolve();
        }
    });
}

/**
 * Performs a fake reload and a local server restart.
 * Checks if after the restart an expected version is being served.
 * @param autoupdate
 * @param version
 */
export async function restartLocalServerAndExpectVersion(autoupdate, version) {
    autoupdate.onReset();
    try {
        await setUpLocalServer(
            autoupdate.getDirectory(), autoupdate.getParentDirectory()
        );
        await expectVersionServedToEqual(version);
    } catch (e) {
        throw new Error(e);
    }
}

/**
 * Checks is a certain asset is currently served from the local server.
 * @param filename
 */
export async function expectAssetToBeServed(filename) {
    const response = await fetchFromLocalServer(`/${filename}`);
    expect(response.status).to.equal(200);
    const body = await response.text();
    expect(body).to.contain(filename);
}

/**
 * Checks is a certain asset wit hspecified content is currently served from the local server.
 * @param path
 * @param expectedContents
 */
export async function expectAssetServedToContain(path, expectedContents) {
    const response = await fetchFromLocalServer(`/${path}`);
    expect(response.status).to.equal(200);
    const body = await response.text();
    expect(body).to.contain(expectedContents);
}
