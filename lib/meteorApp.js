import fs from 'fs';
import { execSync } from 'child_process';
import spawn from 'cross-spawn';
import semver from 'semver';
import path from 'path';
import { fileURLToPath } from 'url';
import * as asar from '@electron/asar';
import IsDesktopInjector from '../skeleton/modules/autoupdate/isDesktopInjector.js';
import Log from './log.js';
import MeteorManager from './meteorManager.js';

const { join } = path;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sll = (text) => process.stdout.write(text ? `${text}\r` : '\r');

/**
 * Recursively sets permissions on a directory and all its contents.
 * @param {string} dirPath - directory path
 * @param {Number} mode - octal permission mode (e.g. 0o777)
 */
function chmodRecursive(dirPath, mode) {
    fs.chmodSync(dirPath, mode);
    fs.readdirSync(dirPath, { withFileTypes: true }).forEach((dirent) => {
        const full = path.join(dirPath, dirent.name);
        if (dirent.isDirectory()) {
            chmodRecursive(full, mode);
        } else {
            fs.chmodSync(full, mode);
        }
    });
}

// TODO: refactor all strategy ifs to one place

/**
 * Represents the Meteor app.
 * @property {MeteorDesktop} $
 * @class
 */
export default class MeteorApp {
    /**
     * @param {MeteorDesktop} $ - context
     * @constructor
     */
    constructor($) {
        this.log = new Log('meteorApp');
        this.$ = $;
        this.meteorManager = new MeteorManager($);
        this.mobilePlatform = null;
        this.oldManifest = null;
        this.injector = new IsDesktopInjector();
        this.matcher = new RegExp(
            '__meteor_runtime_config__ = JSON.parse\\(decodeURIComponent\\("([^"]*)"\\)\\)'
        );
        this.replacer = new RegExp(
            '(__meteor_runtime_config__ = JSON.parse\\(decodeURIComponent\\()"([^"]*)"(\\)\\))'
        );
        this.meteorVersion = null;
        this.indexHTMLstrategy = null;

        this.indexHTMLStrategies = {
            INDEX_FROM_LOCAL_BUILD: 1,
            INDEX_FROM_RUNNING_SERVER: 2
        };

        this.deprectatedPackages = ['omega:meteor-desktop-localstorage'];
    }

    /**
     * Remove any deprecated packages from meteor project.
     * @returns {Promise<void>}
     */
    async removeDeprecatedPackages() {
        try {
            if (this.meteorManager.checkPackages(this.deprectatedPackages)) {
                this.log.info('deprecated meteor plugins found, removing them');
                await this.meteorManager.deletePackages(this.deprectatedPackages);
            }
        } catch (e) {
            throw new Error(e);
        }
    }

    /**
     * Ensures that required packages are added to the Meteor app.
     * Uses local plugin symlinks from meteor-desktop's own plugins/ directory instead of
     * fetching from Atmosphere, so the packages work regardless of Atmosphere availability.
     */
    async ensureDesktopHCPPackages() {
        const desktopHCPPackages = ['communitypackages:meteor-desktop-watcher', 'communitypackages:meteor-desktop-bundler'];
        const pluginNames = ['watcher', 'bundler'];
        const meteorDesktopRoot = path.join(__dirname, '..');
        const meteorAppPackagesDir = join(this.$.env.paths.meteorApp.root, 'packages');

        if (this.$.desktop.getSettings().desktopHCP) {
            this.log.verbose('desktopHCP is enabled, linking local plugins into Meteor packages dir');

            if (!fs.existsSync(meteorAppPackagesDir)) {
                fs.mkdirSync(meteorAppPackagesDir);
            }

            pluginNames.forEach((pluginName) => {
                const src = path.join(meteorDesktopRoot, 'plugins', pluginName);
                const dest = join(meteorAppPackagesDir, `meteor-desktop-${pluginName}`);
                if (!fs.existsSync(dest)) {
                    fs.symlinkSync(src, dest, 'dir');
                }
            });

            this.log.verbose('desktopHCP local plugins symlinked — Meteor auto-discovers packages/ dir, no meteor add needed');
        } else {
            this.log.verbose('desktopHCP is not enabled, removing local plugin links and packages');

            pluginNames.forEach((pluginName) => {
                const dest = join(meteorAppPackagesDir, `meteor-desktop-${pluginName}`);
                if (fs.existsSync(dest)) {
                    fs.rmSync(dest, {
                        recursive: true, force: true, maxRetries: 3, retryDelay: 150
                    });
                }
            });

            try {
                if (this.meteorManager.checkPackages(desktopHCPPackages)) {
                    await this.meteorManager.deletePackages(desktopHCPPackages);
                }
            } catch (e) {
                throw new Error(e);
            }
        }
    }

    /**
     * Adds entry to .meteor/.gitignore if necessary.
     */
    updateGitIgnore() {
        this.log.verbose('updating .meteor/.gitignore');
        // Lets read the .meteor/.gitignore and filter out blank lines.
        const gitIgnore = fs.readFileSync(this.$.env.paths.meteorApp.gitIgnore, 'UTF-8')
            .split('\n').filter((ignoredPath) => ignoredPath.trim() !== '');

        if (!~gitIgnore.indexOf(this.$.env.paths.electronApp.rootName)) {
            this.log.verbose(`adding ${this.$.env.paths.electronApp.rootName} to .meteor/.gitignore`);
            gitIgnore.push(this.$.env.paths.electronApp.rootName);

            fs.writeFileSync(this.$.env.paths.meteorApp.gitIgnore, gitIgnore.join('\n'), 'UTF-8');
        }
    }

    /**
     * Reads the Meteor release version used in the app.
     * @returns {string}
     */
    getMeteorRelease() {
        let release = fs.readFileSync(this.$.env.paths.meteorApp.release, 'UTF-8')
            .replace(/\r/gm, '')
            .split('\n')[0];
        ([, release] = release.split('@'));
        // We do not care if it is beta.
        if (~release.indexOf('-')) {
            ([release] = release.split('-'));
        }
        return release;
    }

    /**
     * Cast Meteor release to semver version.
     * @returns {string}
     */
    castMeteorReleaseToSemver() {
        return `${this.getMeteorRelease()}.0.0`.match(/(^\d+\.\d+\.\d+)/gmi)[0];
    }

    /**
     * Validate meteor version against a versionRange.
     * @param {string} versionRange - semver version range
     */
    checkMeteorVersion(versionRange) {
        const release = this.castMeteorReleaseToSemver();
        if (!semver.satisfies(release, versionRange)) {
            if (this.$.env.options.skipMobileBuild) {
                throw new Error(`wrong meteor version (${release}) in project - only `
                    + `${versionRange} is supported`);
            } else {
                throw new Error(`wrong meteor version (${release}) in project - only `
                    + `${versionRange} is supported for automatic meteor builds (you can always `
                    + 'try with `--skip-mobile-build` if you are using meteor >= 1.2.1`');
            }
        }
    }

    /**
     * Decides which strategy to use while trying to get client build out of Meteor project.
     * @returns {number}
     */
    chooseStrategy() {
        if (this.$.env.options.forceLegacyBuild) {
            return this.indexHTMLStrategies.INDEX_FROM_LOCAL_BUILD;
        }

        const release = this.castMeteorReleaseToSemver();
        if (semver.satisfies(release, '> 1.3.4')) {
            return this.indexHTMLStrategies.INDEX_FROM_RUNNING_SERVER;
        }
        if (semver.satisfies(release, '1.3.4')) {
            const explodedVersion = this.getMeteorRelease().split('.');
            if (explodedVersion.length >= 4) {
                if (explodedVersion[3] > 1) {
                    return this.indexHTMLStrategies.INDEX_FROM_RUNNING_SERVER;
                }
                return this.indexHTMLStrategies.INDEX_FROM_LOCAL_BUILD;
            }
        }
        return this.indexHTMLStrategies.INDEX_FROM_LOCAL_BUILD;
    }

    /**
     * Checks required preconditions.
     * - Meteor version
     * - is mobile platform added
     */
    async checkPreconditions() {
        if (this.$.env.options.skipMobileBuild) {
            this.checkMeteorVersion('>= 1.2.1');
        } else {
            this.checkMeteorVersion('>= 1.3.3');
            this.indexHTMLstrategy = this.chooseStrategy();
            if (this.indexHTMLstrategy === this.indexHTMLStrategies.INDEX_FROM_LOCAL_BUILD) {
                this.log.debug(
                    'meteor version is < 1.3.4.2 so the index.html from local build will'
                    + ' be used'
                );
            } else {
                this.log.debug(
                    'meteor version is >= 1.3.4.2 so the index.html will be downloaded '
                    + 'from the running server'
                );
            }
        }

        if (!this.$.env.options.skipMobileBuild) {
            const platforms = fs.readFileSync(this.$.env.paths.meteorApp.platforms, 'UTF-8');
            if (!~platforms.indexOf('android') && !~platforms.indexOf('ios')) {
                if (!this.$.env.options.android) {
                    this.mobilePlatform = 'ios';
                } else {
                    this.mobilePlatform = 'android';
                }
                this.log.warn(`no mobile target detected - will add '${this.mobilePlatform}' `
                    + 'just to get a mobile build');
                try {
                    await this.addMobilePlatform(this.mobilePlatform);
                } catch (e) {
                    this.log.error('failed to add a mobile platform - please try to do it manually');
                    throw e;
                }
            }
        }
    }

    /**
     * Tries to add a mobile platform to meteor project.
     * @param {string} platform - platform to add
     * @returns {Promise}
     */
    addMobilePlatform(platform) {
        return new Promise((resolve, reject) => {
            const currentPlatforms = fs.readFileSync(this.$.env.paths.meteorApp.platforms, 'UTF-8');
            if (~currentPlatforms.indexOf('android') || ~currentPlatforms.indexOf('ios')) {
                this.log.verbose('mobile platform already present, skipping add');
                resolve();
                return;
            }
            this.log.verbose(`adding mobile platform: ${platform}`);
            spawn('meteor', ['add-platform', platform], {
                cwd: this.$.env.paths.meteorApp.root,
                stdio: this.$.env.stdio
            }).on('exit', () => {
                const updatedPlatforms = fs.readFileSync(this.$.env.paths.meteorApp.platforms, 'UTF-8');
                if (!~updatedPlatforms.indexOf('android') && !~updatedPlatforms.indexOf('ios')) {
                    reject();
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Tries to remove a mobile platform from meteor project.
     * @param {string} platform - platform to remove
     * @returns {Promise}
     */
    removeMobilePlatform(platform) {
        if (this.$.env.options.skipRemoveMobilePlatform) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const currentPlatforms = fs.readFileSync(this.$.env.paths.meteorApp.platforms, 'UTF-8');
            if (!~currentPlatforms.indexOf(platform)) {
                this.log.verbose(`mobile platform '${platform}' already absent, skipping remove`);
                resolve();
                return;
            }
            this.log.verbose(`removing mobile platform: ${platform}`);
            spawn('meteor', ['remove-platform', platform], {
                cwd: this.$.env.paths.meteorApp.root,
                stdio: this.$.env.stdio,
                env: { METEOR_PRETTY_OUTPUT: 0, ...process.env }
            }).on('exit', () => {
                const updatedPlatforms = fs.readFileSync(this.$.env.paths.meteorApp.platforms, 'UTF-8');
                if (~updatedPlatforms.indexOf(platform)) {
                    reject();
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Just checks for index.html and program.json existence.
     * Uses mtime as a fast pre-check before reading file content (FIX 10).
     * Handles partial JSON reads from concurrent Meteor writes gracefully (FIX 4).
     * @returns {boolean}
     */
    isBuildReady() {
        const legacyMode = this.indexHTMLstrategy === this.indexHTMLStrategies.INDEX_FROM_LOCAL_BUILD;
        const programPath = legacyMode
            ? this.$.env.paths.meteorApp.legacyBuildProgramJson
            : this.$.env.paths.meteorApp.webBrowserProgramJson;

        if (legacyMode && !this.$.utils.exists(this.$.env.paths.meteorApp.legacyBuildIndex)) {
            return false;
        }
        if (!this.$.utils.exists(programPath)) {
            return false;
        }
        if (!this.oldManifest) {
            return true;
        }

        // Fast mtime check: skip content read if file hasn't changed on disk
        try {
            const mtime = fs.statSync(programPath).mtimeMs;
            if (mtime === this.programJsonMtime) {
                return false;
            }
            this.programJsonMtime = mtime;
        } catch {
            return false;
        }

        // Content read — wrapped to handle partial writes from Meteor (FIX 4)
        try {
            return this.oldManifest !== fs.readFileSync(programPath, 'UTF-8');
        } catch {
            return false;
        }
    }

    /**
     * Fetches index.html from running project.
     * @returns {Promise.<String>}
     */
    async acquireIndex() {
        const port = (this.$.env.options.port) ? this.$.env.options.port : 3080;
        const url = `http://127.0.0.1:${port}/`;
        this.log.info('acquiring index.html');
        this.log.debug(`fetching index.html from ${url}`);
        const res = await fetch(url);
        this.log.debug(`index.html fetch status: ${res.status}`);
        const text = await res.text();
        if (!res.ok) {
            this.log.debug(`index.html response body: ${text.substring(0, 500)}`);
            throw new Error(`failed to fetch index.html: HTTP ${res.status} from ${url}`);
        }
        if (!text.trim()) {
            throw new Error(`fetched index.html from ${url} but got empty response`);
        }
        return text;
    }

    /**
     * Reads program.json from the on-disk web.browser build output.
     * The file is always present on disk by the time isBuildReady() returns true.
     * @returns {Object}
     */
    acquireManifest() {
        const programJsonPath = this.$.env.paths.meteorApp.webBrowserProgramJson;
        this.log.info('acquiring program.json from local build');
        this.log.debug(`reading program.json from ${programJsonPath}`);
        if (!fs.existsSync(programJsonPath)) {
            throw new Error(
                `program.json not found at ${programJsonPath}. `
                + 'Ensure the Meteor app has completed its initial build.'
            );
        }
        const text = fs.readFileSync(programJsonPath, 'UTF-8');
        const trimmed = text.trim();
        if (!trimmed) {
            throw new Error(`program.json at ${programJsonPath} is empty`);
        }
        try {
            return JSON.parse(text);
        } catch (e) {
            this.log.debug(`program.json raw content: ${text.substring(0, 500)}`);
            throw new Error(`program.json at ${programJsonPath} is not valid JSON: ${e.message}`);
        }
    }

    /**
     * Tries to get a mobile build from meteor app.
     * In case of failure leaves a meteor.log.
     * A lot of stuff is happening here - but the main aim is to get a build from
     * Meteor build output and exit as soon as possible.
     *
     * @returns {Promise}
     */
    buildMobileTarget() {
        const programJson = (this.indexHTMLstrategy === this.indexHTMLStrategies.INDEX_FROM_LOCAL_BUILD)
            ? this.$.env.paths.meteorApp.legacyBuildProgramJson
            : this.$.env.paths.meteorApp.webBrowserProgramJson;

        if (this.$.utils.exists(programJson)) {
            this.oldManifest = fs.readFileSync(programJson, 'UTF-8');
            try { this.programJsonMtime = fs.statSync(programJson).mtimeMs; } catch { this.programJsonMtime = 0; }
        }

        return new Promise((resolve, reject) => {
            const self = this;
            let log = '';
            let desiredExit = false;
            let buildTimeout = null;
            let errorTimeout = null;
            let messageTimeout = null;
            let killTimeout = null;
            let buildCheckInterval = null;
            let portProblem = false;

            function windowsKill(pid) {
                self.log.debug(`killing pid: ${pid}`);
                spawn.sync('taskkill', ['/pid', pid, '/f', '/t']);

                // We will look for other process which might have been created outside the
                // process tree.
                // Lets list all node.exe processes.

                const out = spawn
                    .sync(
                        'wmic',
                        ['process', 'where', 'caption="node.exe"', 'get', 'commandline,processid']
                    )
                    .stdout.toString('utf-8')
                    .split('\n');
                const args = self.prepareArguments();
                // Lets mount regex.
                const regexV1 = new RegExp(`${args.join('\\s+')}\\s+(\\d+)`, 'gm');
                const regexV2 = new RegExp(`"${args.join('"\\s+"')}"\\s+(\\d+)`, 'gm');
                // No we will check for those with the matching params.
                out.forEach((line) => {
                    const match = regexV1.exec(line) || regexV2.exec(line) || false;
                    if (match) {
                        self.log.debug(`killing pid: ${match[1]}`);
                        spawn.sync('taskkill', ['/pid', match[1], '/f', '/t']);
                    }
                    regexV1.lastIndex = 0;
                    regexV2.lastIndex = 0;
                });
            }

            function writeLog() {
                fs.writeFileSync('meteor.log', log, 'UTF-8');
            }

            function clearTimeoutsAndIntervals() {
                clearInterval(buildCheckInterval);
                clearTimeout(buildTimeout);
                clearTimeout(errorTimeout);
                clearTimeout(messageTimeout);
                clearTimeout(killTimeout);
            }

            const args = this.prepareArguments();

            this.log.info(`running "meteor ${args.join(' ')}"... this might take a while`);

            const env = { METEOR_PRETTY_OUTPUT: 0, METEOR_NO_RELEASE_CHECK: 1 };
            if (this.$.env.options.prodDebug) {
                env.METEOR_DESKOP_PROD_DEBUG = true;
            }

            // Lets spawn meteor.
            const child = spawn(
                'meteor',
                args,
                {
                    env: Object.assign(env, process.env),
                    cwd: this.$.env.paths.meteorApp.root
                },
                { shell: true }
            );

            // Kills the currently running meteor command.
            function kill(signal = 'SIGKILL') {
                sll('');
                child.kill(signal);
                if (self.$.env.os.isWindows) {
                    windowsKill(child.pid);
                }
            }

            function exit() {
                killTimeout = setTimeout(() => {
                    clearTimeoutsAndIntervals();
                    desiredExit = true;
                    kill('SIGTERM');
                    resolve();
                }, 500);
            }

            function copyBuild() {
                self.copyBuild().then(() => {
                    exit();
                }).catch(() => {
                    clearTimeoutsAndIntervals();
                    kill();
                    writeLog();
                    reject('copy');
                });
            }

            buildCheckInterval = setInterval(() => {
                // Check if we already have a build ready.
                if (this.isBuildReady()) {
                    // Clear immediately to prevent double-trigger if copyBuild takes >1s
                    clearInterval(buildCheckInterval);
                    if (this.indexHTMLstrategy
                        === this.indexHTMLStrategies.INDEX_FROM_LOCAL_BUILD) {
                        copyBuild();
                    }
                }
            }, 1000);

            child.stderr.on('data', (chunk) => {
                const line = chunk.toString('UTF-8');
                log += `${line}\n`;
                if (errorTimeout) {
                    clearTimeout(errorTimeout);
                }
                // Do not exit if this is the warning for using --production.
                // Output exceeds -> https://github.com/meteor/meteor/issues/8592
                if (
                    !~line.indexOf('--production')
                    && !~line.indexOf('Output exceeds ')
                    && !~line.indexOf('Node#moveTo')
                    && !~line.indexOf('Browserslist')
                    && !~line.indexOf('Failed to start watcher')
                    && (
                        Array.isArray(self.$.env.options.ignoreStderr)
                        && self.$.env.options.ignoreStderr.every((str) => !~line.indexOf(str))
                    )
                ) {
                    self.log.warn('STDERR:', line);
                    // We will exit 1s after last error in stderr.
                    errorTimeout = setTimeout(() => {
                        clearTimeoutsAndIntervals();
                        kill();
                        writeLog();
                        reject('error');
                    }, 1000);
                }
            });

            child.stdout.on('data', (chunk) => {
                const line = chunk.toString('UTF-8');
                if (!desiredExit && line.trim().replace(/[\n\r\t\v\f]+/gm, '') !== '') {
                    const linesToDisplay = line.trim()
                        .split('\n\r');
                    // Only display last line from the chunk.
                    const sanitizedLine = linesToDisplay.pop().replace(/[\n\r\t\v\f]+/gm, '');
                    sll(sanitizedLine);
                }
                log += `${line}\n`;
                if (~line.indexOf('after_platform_add')) {
                    sll('');
                    this.log.info('done... 10%');
                }

                if (~line.indexOf('Local package version')) {
                    if (messageTimeout) {
                        clearTimeout(messageTimeout);
                    }
                    messageTimeout = setTimeout(() => {
                        sll('');
                        this.log.info('building in progress...');
                    }, 1500);
                }

                if (~line.indexOf('Preparing mobile project')) {
                    sll('');
                    this.log.info('done... 60%');
                }

                if (~line.indexOf('Can\'t listen on port')) {
                    portProblem = true;
                }

                if (~line.indexOf('Your application has errors')) {
                    if (errorTimeout) {
                        clearTimeout(errorTimeout);
                    }
                    errorTimeout = setTimeout(() => {
                        clearTimeoutsAndIntervals();
                        kill();
                        writeLog();
                        reject('errorInApp');
                    }, 1000);
                }

                if (~line.indexOf('App running at')) {
                    copyBuild();
                }
            });

            // When Meteor exits
            child.on('exit', () => {
                sll('');
                clearTimeoutsAndIntervals();
                if (!desiredExit) {
                    writeLog();
                    if (portProblem) {
                        reject('port');
                    } else {
                        reject('exit');
                    }
                }
            });

            buildTimeout = setTimeout(() => {
                kill();
                writeLog();
                reject('timeout');
            }, this.$.env.options.buildTimeout ? this.$.env.options.buildTimeout * 1000 : 600000);
        });
    }

    /**
     * Replaces the DDP url that was used originally when Meteor was building the client.
     * @param {string} indexHtml - path to index.html from the client
     */
    updateDdpUrl(indexHtml) {
        let content;
        let runtimeConfig;

        try {
            content = fs.readFileSync(indexHtml, 'UTF-8');
        } catch (e) {
            throw new Error(`error loading index.html file: ${e.message}`);
        }
        if (!this.matcher.test(content)) {
            throw new Error('could not find runtime config in index file');
        }

        try {
            const matches = content.match(this.matcher);
            runtimeConfig = JSON.parse(decodeURIComponent(matches[1]));
        } catch (e) {
            throw new Error(`could not parse runtime config in index file: ${e.message}`);
        }

        if (this.$.env.options.ddpUrl.substr(-1, 1) !== '/') {
            this.$.env.options.ddpUrl += '/';
        }

        runtimeConfig.ROOT_URL = this.$.env.options.ddpUrl;
        runtimeConfig.DDP_DEFAULT_CONNECTION_URL = this.$.env.options.ddpUrl;

        content = content.replace(
            this.replacer, `$1"${encodeURIComponent(JSON.stringify(runtimeConfig))}"$3`
        );

        try {
            fs.writeFileSync(indexHtml, content);
        } catch (e) {
            throw new Error(`error writing index.html file: ${e.message}`);
        }
        this.log.info('successfully updated ddp string in the runtime config of a mobile build'
            + ` to ${this.$.env.options.ddpUrl}`);
    }

    /**
     * Prepares the arguments passed to `meteor` command.
     * @returns {string[]}
     */
    prepareArguments() {
        const args = ['run', '--verbose'];
        if (this.$.env.isProductionBuild()) {
            args.push('--production');
        }
        args.push('-p');
        if (this.$.env.options.port) {
            args.push(this.$.env.options.port);
        } else {
            args.push('3080');
        }
        if (this.$.env.options.meteorSettings) {
            args.push('--settings', this.$.env.options.meteorSettings);
        }
        return args;
    }

    /**
     * Validates the mobile build and copies it into electron app.
     */
    async copyBuild() {
        this.log.debug('clearing build dir');
        try {
            await this.$.utils.rmWithRetries('-rf', this.$.env.paths.electronApp.meteorApp);
        } catch (e) {
            throw new Error(e);
        }

        let prefix = 'legacyBuild';
        let copyPathPostfix = '';

        if (this.indexHTMLstrategy === this.indexHTMLStrategies.INDEX_FROM_RUNNING_SERVER) {
            prefix = 'webBrowser';
            copyPathPostfix = `${path.sep}*`;
            let indexHtml;
            try {
                fs.mkdirSync(this.$.env.paths.electronApp.meteorApp);
                indexHtml = await this.acquireIndex();
                fs.writeFileSync(this.$.env.paths.electronApp.meteorAppIndex, indexHtml);
                this.log.info('successfully downloaded index.html from running meteor app');
            } catch (e) {
                this.log.error('error while trying to download index.html for web.browser, '
                    + 'be sure that you are running a meteor server: ', e);
                throw e;
            }
        }

        const buildDir = this.$.env.paths.meteorApp[prefix];
        const { legacyBuildIndex } = this.$.env.paths.meteorApp;
        const buildProgramJson = this.$.env.paths.meteorApp[`${prefix}ProgramJson`];

        if (!this.$.utils.exists(buildDir)) {
            this.log.error(`no build found at ${buildDir}`);
            this.log.error('are you sure meteor has finished building?');
            throw new Error('required file not present');
        }

        if (!this.$.utils.exists(buildProgramJson)) {
            this.log.error('no program.json found in build found at '
                + `${buildDir}`);
            this.log.error('are you sure meteor has finished building?');
            throw new Error('required file not present');
        }

        if (this.indexHTMLstrategy !== this.indexHTMLStrategies.INDEX_FROM_RUNNING_SERVER) {
            if (!this.$.utils.exists(legacyBuildIndex)) {
                this.log.error('no index.html found in build found at '
                    + `${buildDir}`);
                this.log.error('are you sure meteor has finished building?');
                throw new Error('required file not present');
            }
        }

        this.log.verbose('copying browser build');
        if (copyPathPostfix) {
            // webBrowser: copy contents of buildDir into existing meteorApp dir
            fs.readdirSync(buildDir).forEach((item) => {
                fs.cpSync(
                    path.join(buildDir, item),
                    path.join(this.$.env.paths.electronApp.meteorApp, item),
                    { recursive: true }
                );
            });
        } else {
            // legacyBuild: meteorApp was deleted — create it as a copy of buildDir
            fs.cpSync(buildDir, this.$.env.paths.electronApp.meteorApp, { recursive: true });
        }

        // Clear restrictive permissions set by @electron/rebuild on all platforms.
        // attrib command remains Windows-only; chmodRecursive is needed on macOS/Linux too.
        chmodRecursive(this.$.env.paths.electronApp.meteorApp, 0o777);
        if (this.$.env.os.isWindows) {
            execSync(`attrib -r "${this.$.env.paths.electronApp.meteorApp}${path.sep}*.*" /s`);
        }

        if (this.indexHTMLstrategy === this.indexHTMLStrategies.INDEX_FROM_RUNNING_SERVER) {
            let programJson;
            try {
                programJson = this.acquireManifest();
                fs.writeFileSync(
                    this.$.env.paths.electronApp.meteorAppProgramJson,
                    JSON.stringify(programJson, null, 4)
                );
                this.log.info('successfully read program.json from local web.browser build');
            } catch (e) {
                this.log.error('error while trying to read program.json for web.browser,'
                    + ' be sure that Meteor has completed its initial build: ', e);
                throw e;
            }
        }

        this.log.info('build copied to electron app');

        this.validateBundleStructure();
        this.$.electronApp.validationGatesPassed.push('A2 bundle structure');

        this.log.debug('copy desktop-hcp.js to meteor build');
        const desktopHcpSrc = join(__dirname, '..', 'skeleton', 'desktop-hcp.js');
        fs.copyFileSync(desktopHcpSrc, path.join(this.$.env.paths.electronApp.meteorApp, path.basename(desktopHcpSrc)));
    }

    /**
     * A2: Validates the copied web.browser build structure after copyBuild.
     * Verifies meteorApp dir exists, index.html is present, and at least one JS file
     * exists at root level (Meteor 3.x single-bundle) or in packages/.
     * @throws {Error} if required files or directories are missing
     */
    validateBundleStructure() {
        const meteorAppDir = this.$.env.paths.electronApp.meteorApp;
        const indexHtml = this.$.env.paths.electronApp.meteorAppIndex;

        if (!fs.existsSync(meteorAppDir)) {
            throw new Error('A2: bundle structure invalid — meteorApp directory not found');
        }

        if (!fs.existsSync(indexHtml)) {
            throw new Error('A2: bundle structure invalid — index.html not found in copied build');
        }

        // Meteor 3.x places a single root-level hash-named JS bundle; older builds use packages/
        const rootJsFiles = fs.readdirSync(meteorAppDir).filter((f) => f.endsWith('.js'));
        const packagesDir = path.join(meteorAppDir, 'packages');
        const packagesJsFiles = fs.existsSync(packagesDir)
            ? fs.readdirSync(packagesDir).filter((f) => f.endsWith('.js'))
            : [];

        if (rootJsFiles.length === 0 && packagesJsFiles.length === 0) {
            throw new Error('A2: bundle structure invalid — no JS files found at root level or in packages/');
        }

        this.log.info(
            `A2: bundle structure OK — index.html present, ${rootJsFiles.length} root JS file(s),`
            + ` ${packagesJsFiles.length} JS file(s) in packages/`
        );
    }

    /**
     * A2.5: Hash coherence gate — validates that every script src in index.html resolves to a
     * file on disk. Runs auto-repair (program.json lookup then mtime fallback) when a stale hash
     * is detected. Must run after validateBundleStructure (A2) and before injectEsm.
     * @throws {Error} if any script src is missing and cannot be auto-repaired
     */
    validateHashCoherence() {
        const meteorAppDir = this.$.env.paths.electronApp.meteorApp;
        const indexHtml = this.$.env.paths.electronApp.meteorAppIndex;
        let htmlContent = fs.readFileSync(indexHtml, 'UTF-8');
        const srcRegex = /<script[^>]+src="([^"]+)"/g;
        const allSrcMatches = [...htmlContent.matchAll(srcRegex)];
        const missingSrcs = [];

        allSrcMatches.forEach((m) => {
            const src = m[1];
            const srcPath = src.split('?')[0];
            if (!fs.existsSync(path.join(meteorAppDir, srcPath))) {
                missingSrcs.push(src);
            }
        });

        if (missingSrcs.length === 0) {
            this.log.info('A2.5: hash coherence OK — all script srcs resolve to files on disk');
            return;
        }

        // Auto-repair: find root-level JS files not referenced by any script src
        const referencedSrcPaths = new Set(
            allSrcMatches.map((m) => m[1].split('?')[0].replace(/^\//, ''))
        );
        const unreferencedFiles = fs.readdirSync(meteorAppDir)
            .filter((file) => {
                if (!file.endsWith('.js')) {
                    return false;
                }
                const filePath = path.join(meteorAppDir, file);
                if (!fs.statSync(filePath).isFile()) {
                    return false;
                }
                return !referencedSrcPaths.has(file);
            });

        // Known non-bundle files that live on disk but are not referenced by script tags.
        // Exclude them when searching for a repair candidate so they don't create ambiguity.
        const KNOWN_NON_BUNDLE_FILES = new Set(['desktop-hcp.js']);
        const bundleCandidates = unreferencedFiles.filter(
            (file) => !KNOWN_NON_BUNDLE_FILES.has(file)
        );

        if (missingSrcs.length === 1 && bundleCandidates.length >= 1) {
            // Repair: rewrite the stale hash to the real bundle file on disk.
            // When multiple candidates exist (e.g. leftover from a prior build),
            // consult program.json to find the authoritative bundle filename.
            // Fall back to newest-by-mtime if program.json cannot resolve it.
            const staleSrc = missingSrcs[0];
            let realFile;
            if (bundleCandidates.length === 1) {
                ([realFile] = bundleCandidates);
            } else {
                // Multiple candidates — try program.json first
                const programJsonPath = path.join(meteorAppDir, 'program.json');
                let resolvedFromManifest = null;
                if (fs.existsSync(programJsonPath)) {
                    try {
                        const programJson = JSON.parse(fs.readFileSync(programJsonPath, 'UTF-8'));
                        const manifestEntries = (programJson && programJson.manifest) || [];
                        // Root-level JS bundle entries have no directory separator in path
                        const manifestBundleFiles = new Set(
                            manifestEntries
                                .filter((e) => e.type === 'js' && !e.path.includes('/'))
                                .map((e) => e.path)
                        );
                        const manifestMatches = bundleCandidates.filter(
                            (f) => manifestBundleFiles.has(f)
                        );
                        if (manifestMatches.length === 1) {
                            ([resolvedFromManifest] = manifestMatches);
                            this.log.info(
                                'A2.5: resolved ambiguous candidates via'
                                + ` program.json → ${resolvedFromManifest}`
                            );
                        }
                    } catch (e) {
                        this.log.warn(
                            'A2.5: could not parse program.json for'
                            + ` disambiguation: ${e.message}`
                        );
                    }
                }
                if (resolvedFromManifest) {
                    realFile = resolvedFromManifest;
                } else {
                    // program.json unavailable or ambiguous — fall back to newest by mtime
                    realFile = bundleCandidates.reduce((newest, file) => {
                        const newestMtime = fs.statSync(path.join(meteorAppDir, newest)).mtimeMs;
                        const fileMtime = fs.statSync(path.join(meteorAppDir, file)).mtimeMs;
                        return fileMtime > newestMtime ? file : newest;
                    });
                    this.log.info(
                        `A2.5: resolved ambiguous candidates by mtime → ${realFile}`
                    );
                }
            }
            // Preserve the original query string and leading slash if present
            const queryString = staleSrc.includes('?') ? staleSrc.slice(staleSrc.indexOf('?')) : '';
            const leadingSlash = staleSrc.startsWith('/') ? '/' : '';
            const newSrc = `${leadingSlash}${realFile}${queryString}`;
            htmlContent = htmlContent.split(staleSrc).join(newSrc);
            fs.writeFileSync(indexHtml, htmlContent);
            this.log.info(`A2.5: auto-repaired stale hash — replaced ${staleSrc} with ${newSrc}`);
        } else {
            const srcList = missingSrcs.join('\n');
            throw new Error(
                `A2.5: ${missingSrcs.length} script src(s) missing on disk,`
                + ` ${bundleCandidates.length} unreferenced JS file(s) found — cannot auto-repair:\n${srcList}`
            );
        }
    }

    /**
     * Injects Meteor.isDesktop
     */
    injectIsDesktop() {
        this.log.info('injecting isDesktop');

        let manifestJsonPath = this.$.env.paths.meteorApp.legacyBuildProgramJson;
        if (this.indexHTMLstrategy === this.indexHTMLStrategies.INDEX_FROM_RUNNING_SERVER) {
            manifestJsonPath = this.$.env.paths.meteorApp.webBrowserProgramJson;
        }

        try {
            const { manifest } = JSON.parse(
                fs.readFileSync(manifestJsonPath, 'UTF-8')
            );
            let injected = false;
            let injectedStartupDidComplete = false;
            let result = null;

            // We will search in every .js file in the manifest.
            // We could probably detect whether this is a dev or production build and only search in
            // the correct files, but for now this should be fine.
            manifest.forEach((file) => {
                if (file.type !== 'js') {
                    return;
                }
                const filePath = join(this.$.env.paths.electronApp.meteorApp, file.path);
                let fileContents;
                try {
                    fileContents = fs.readFileSync(filePath, 'UTF-8');
                } catch (e) {
                    throw new Error(`injectIsDesktop: cannot read ${file.path}: ${e.message}`);
                }
                const original = fileContents;
                result = this.injector.processFileContents(fileContents);

                ({ fileContents } = result);
                injectedStartupDidComplete = result.injectedStartupDidComplete ? true : injectedStartupDidComplete;
                injected = result.injected ? true : injected;

                // Only write if content was modified (FIX 7: skip unchanged files)
                if (fileContents !== original) {
                    try {
                        fs.writeFileSync(filePath, fileContents);
                    } catch (e) {
                        throw new Error(`injectIsDesktop: cannot write ${file.path}: ${e.message}`);
                    }
                }
            });

            if (!injected) {
                throw new Error('error injecting isDesktop global var — pattern not found in any manifest JS file');
            }
            if (!injectedStartupDidComplete) {
                throw new Error(
                    'error injecting isDesktop for startupDidComplete — pattern not found in any manifest JS file'
                );
            }
        } catch (e) {
            this.log.error('error occurred while injecting isDesktop: ', e);
            throw e;
        }
        this.log.info('injected successfully');
    }

    /**
     * Patches Meteor 3.x JS bundles for Electron compatibility.
     *
     * Strategy: scripts run as CLASSIC (not type="module") to preserve shared global scope.
     * Meteor packages assume a single shared global scope — converting to type="module" enforces
     * strict mode, which breaks bare global assignments like `CollectionExtensions = {}` and
     * `WebAppLocalServer = {}` with ReferenceError. Classic scripts share window as global scope.
     *
     * To avoid the SyntaxError that `import.meta` causes in classic scripts, this method
     * replaces all `import.meta` occurrences with an inline polyfill `({url: location.href})`.
     *
     * This method applies the following patches:
     * 1. Fix global object references: `var global = this;` → `var global = window;`
     * 2. Fix IIFE calls: `}).call(this)` → `}).call(this || window)`
     * 3. Polyfill import.meta: `import.meta` → `({url: location.href})`
     * 4. Inject setImmediate polyfill into index.html (Meteor relies on setImmediate)
     */
    injectEsm() {
        this.log.info('applying native ESM patches for Meteor 3.x compatibility');
        const meteorAppDir = this.$.env.paths.electronApp.meteorApp;
        const packagesDir = path.join(meteorAppDir, 'packages');
        const indexHtml = this.$.env.paths.electronApp.meteorAppIndex;
        let totalJsPatchedCount = 0;

        // PATCH 1: Fix global object reference in ALL packages
        // In ES modules, `this` at the top level is undefined, so we need to use `window`.
        // Almost all Meteor packages start with `var global = this;` which shadows the global object
        // with undefined in ESM. We must patch this in ALL files.
        try {
            if (fs.existsSync(packagesDir)) {
                const files = fs.readdirSync(packagesDir);
                let patchedCount = 0;

                files.forEach((file) => {
                    if (!file.endsWith('.js')) {
                        return;
                    }
                    const filePath = path.join(packagesDir, file);
                    const orig = fs.readFileSync(filePath, 'UTF-8');
                    // Single-pass replace (FIX 9: eliminates includes()/match() pre-checks)
                    const patched = orig
                        .replace(/var global = this;/g, 'var global = window;')
                        .replace(/global\s*=\s*this;/g, 'global = window;')
                        .replace(/\}\)\.call\(this\)/g, '}).call(this || window)')
                        .replace(/\}\.call\(this\)/g, '}.call(this || window)')
                        .replace(/\bimport\.meta\b/g, '({url: location.href})');
                    if (patched !== orig) {
                        fs.writeFileSync(filePath, patched);
                        patchedCount += 1;
                    }
                });

                if (patchedCount > 0) {
                    this.log.info(`patched ${patchedCount} files in packages/: fixed global assignments and IIFEs`);
                }
                totalJsPatchedCount += patchedCount;
            }

            // PATCH: Fix strict mode global assignments in app/ directory (global-imports.js, app.js)
            const appDir = path.join(meteorAppDir, 'app');
            // Defined outside the forEach to keep indentation within max-len
            const appSafeInitRe = /if\s*\(\s*typeof\s+([a-zA-Z0-9_$]+)\s*===\s*['"]undefined['"]\s*\)\s*\{\s*\1\s*=/g;
            if (fs.existsSync(appDir)) {
                const appFiles = fs.readdirSync(appDir);
                let appPatchedCount = 0;

                appFiles.forEach((file) => {
                    if (!file.endsWith('.js')) {
                        return;
                    }
                    const filePath = path.join(appDir, file);
                    const orig = fs.readFileSync(filePath, 'UTF-8');
                    // Single-pass replace (FIX 9: eliminates includes()/match() pre-checks)
                    const patched = orig
                        .replace(appSafeInitRe, "if (typeof window.$1 === 'undefined') { window.$1 =")
                        .replace(/^([a-zA-Z0-9_$]+)\s*=\s*(Package[.[].*)/gm, 'window.$1 = $2')
                        .replace(/var require = meteorInstall/g, 'var require = window.meteorInstall')
                        .replace(/\}\)\.call\(this\)/g, '}).call(this || window)')
                        .replace(/\bimport\.meta\b/g, '({url: location.href})');
                    if (patched !== orig) {
                        fs.writeFileSync(filePath, patched);
                        appPatchedCount += 1;
                    }
                });

                if (appPatchedCount > 0) {
                    this.log.info(
                        `patched ${appPatchedCount} files in app/: fixed strict mode globals and meteorInstall`
                    );
                }
                totalJsPatchedCount += appPatchedCount;
            }
            // PATCH: Fix root-level combined bundle (Meteor 3.x puts all package JS into a single
            // hash-named file at the meteorApp root, e.g. a1b2c3.js). This file is missed by the
            // packages/ and app/ scans above, so .call(this) patterns remain unpatched.
            const rootFiles = fs.readdirSync(meteorAppDir);
            let rootPatchedCount = 0;
            // Cache final content for each root JS file (FIX 6: avoid re-reading in validation)
            const rootContentCache = new Map();

            rootFiles.forEach((file) => {
                if (!file.endsWith('.js')) {
                    return;
                }
                const filePath = path.join(meteorAppDir, file);
                if (!fs.statSync(filePath).isFile()) {
                    return;
                }
                const orig = fs.readFileSync(filePath, 'UTF-8');
                // Single-pass replace (FIX 9: eliminates includes()/match() pre-checks)
                const patchedContent = orig
                    .replace(/var global = this;/g, 'var global = window;')
                    .replace(/global\s*=\s*this;/g, 'global = window;')
                    .replace(/\}\)\.call\(this\)/g, '}).call(this || window)')
                    .replace(/\}\.call\(this\)/g, '}.call(this || window)')
                    .replace(/^([a-zA-Z0-9_$]+)\s*=\s*(Package[.[].*)/gm, 'window.$1 = $2')
                    .replace(/\bimport\.meta\b/g, '({url: location.href})');
                if (patchedContent !== orig) {
                    fs.writeFileSync(filePath, patchedContent);
                    rootPatchedCount += 1;
                }
                // Cache final content to avoid re-read in validation (FIX 6)
                rootContentCache.set(filePath, patchedContent);
            });

            if (rootPatchedCount > 0) {
                this.log.info(`patched ${rootPatchedCount} root-level JS files: fixed global assignments and IIFEs`);
            }
            totalJsPatchedCount += rootPatchedCount;

            if (totalJsPatchedCount === 0) {
                throw new Error(
                    'injectEsm: patched 0 JS files across packages/, app/, and root — '
                    + 'build output structure may have changed, ESM patches were not applied'
                );
            }

            if (rootPatchedCount === 0) {
                throw new Error(
                    'injectEsm: patched 0 root-level JS files — '
                    + 'the Meteor 3.x combined bundle was not found or not patched; '
                    + 'global assignments will remain broken'
                );
            }

            // VALIDATION: residual scan — ensure no files still have unpatched patterns
            const residualErrors = [];
            const scanDirs = [packagesDir, path.join(meteorAppDir, 'app')];
            scanDirs.forEach((dir) => {
                if (!fs.existsSync(dir)) {
                    return;
                }
                fs.readdirSync(dir).forEach((file) => {
                    if (!file.endsWith('.js')) {
                        return;
                    }
                    const filePath = path.join(dir, file);
                    const content = fs.readFileSync(filePath, 'UTF-8');
                    if (
                        content.includes('var global = this;')
                        || content.match(/\}\)\.call\(this\)(?!\s*\|\|)/)
                        || content.includes('import.meta')
                    ) {
                        residualErrors.push(filePath);
                    }
                });
            });
            // Validate root-level files using cached content (FIX 6: no re-read)
            rootContentCache.forEach((content, filePath) => {
                const barePackageAssignRegex = /^([a-zA-Z0-9_$]+)\s*=\s*(Package[.[].*)/m;
                if (
                    content.includes('var global = this;')
                    || content.match(/\}\)\.call\(this\)(?!\s*\|\|)/)
                    || content.includes('import.meta')
                    || content.match(barePackageAssignRegex)
                ) {
                    residualErrors.push(filePath);
                }
            });
            if (residualErrors.length > 0) {
                const errList = residualErrors.join('\n');
                const errMsg = `injectEsm: ${residualErrors.length} JS file(s) with residual patterns:\n${errList}`;
                throw new Error(errMsg);
            }
        } catch (e) {
            this.log.error(`error patching global reference in packages: ${e.message}`);
            throw e;
        }

        // PATCH 2: Inject setImmediate polyfill into index.html.
        // Scripts run as CLASSIC (not type="module") to preserve shared global scope.
        // Meteor packages use bare global assignments (CollectionExtensions = {}, etc.)
        // that throw ReferenceError in strict module context. Classic scripts share one
        // global scope, allowing cross-script global access. import.meta was polyfilled
        // inline in each JS file (PATCH 1 above), so type="module" is not needed.
        try {
            let htmlContent = fs.readFileSync(indexHtml, 'UTF-8');

            // Inject setImmediate polyfill — Meteor relies on setImmediate which is a
            // Node.js global not available in the browser/Electron renderer by default.
            const setImmediatePolyfill = `<script>
// setImmediate polyfill for Meteor 3.x
window.setImmediate = window.setImmediate || function(f) { return setTimeout(f, 0) };
window.clearImmediate = window.clearImmediate || function(i) { clearTimeout(i) };
</script>
`;
            // Insert before the first script tag
            if (!htmlContent.includes('window.setImmediate')) {
                htmlContent = htmlContent.replace(/<script/i, `${setImmediatePolyfill}<script`);
                this.log.info('injected setImmediate polyfill');
            }

            fs.writeFileSync(indexHtml, htmlContent);
            this.log.info('patched index.html: setImmediate polyfill injected, scripts kept as classic');

            // VALIDATION: verify every script src references a file that exists on disk
            const srcRegex = /<script[^>]+src="([^"]+)"/g;
            const missingSrcs = [];
            const allSrcMatches = [...htmlContent.matchAll(srcRegex)];
            allSrcMatches.forEach((m) => {
                const src = m[1];
                // Strip query string (e.g. ?meteor_js_resource=true) before checking disk
                const srcPath = src.split('?')[0];
                if (!fs.existsSync(path.join(meteorAppDir, srcPath))) {
                    missingSrcs.push(src);
                }
            });
            if (missingSrcs.length > 0) {
                // A2.5 (validateHashCoherence) should have caught and repaired any stale hashes
                // before injectEsm runs. If we reach here, something went wrong after A2.5.
                const srcList = missingSrcs.join('\n');
                throw new Error(
                    `injectEsm: ${missingSrcs.length} script src(s) missing on disk`
                    + ` after A2.5 hash coherence gate — cannot proceed:\n${srcList}`
                );
            }
        } catch (e) {
            this.log.error(`error patching index.html for ESM: ${e.message}`);
            throw e;
        }
    }

    /**
     * Builds, modifies and copies the meteor app to electron app.
     */
    async build() {
        this.log.info('checking for any mobile platform');
        try {
            await this.checkPreconditions();
        } catch (e) {
            this.log.error('error occurred during checking preconditions: ', e);
            process.exit(1);
        }

        this.log.info('building meteor app');

        if (!this.$.env.options.skipMobileBuild) {
            try {
                await this.buildMobileTarget();
            } catch (reason) {
                switch (reason) {
                    case 'timeout':
                        this.log.error(
                            'timeout while building, log has been written to meteor.log'
                        );
                        break;
                    case 'error':
                        this.log.error(
                            'build was terminated by meteor-desktop as some errors were reported to stderr, you '
                            + 'should see it above, also check meteor.log for more info, to ignore it use the '
                            + '--ignore-stderr "<string>"'
                        );
                        break;
                    case 'errorInApp':
                        this.log.error(
                            'your meteor app has errors - look into meteor.log for more'
                            + ' info'
                        );
                        break;
                    case 'port':
                        this.log.error(
                            'your port 3080 is currently used (you probably have this or other '
                            + 'meteor project running?), use `-t` or `--meteor-port` to use '
                            + 'different port while building'
                        );
                        break;
                    case 'exit':
                        this.log.error(
                            'meteor cmd exited unexpectedly, log has been written to meteor.log'
                        );
                        break;
                    case 'copy':
                        this.log.error(
                            'error encountered when copying the build'
                        );
                        break;
                    default:
                        this.log.error('error occurred during building mobile target', reason);
                }
                if (this.mobilePlatform) {
                    await this.removeMobilePlatform(this.mobilePlatform);
                }
                process.exit(1);
            }
        } else {
            this.indexHTMLstrategy = this.chooseStrategy();
            try {
                await this.copyBuild();
            } catch (e) {
                process.exit(1);
            }
        }

        try {
            this.validateHashCoherence();
        } catch (e) {
            this.log.error(`A2.5 hash coherence gate failed: ${e.message}`);
            throw e;
        }
        this.$.electronApp.validationGatesPassed.push('A2.5 hash coherence');

        try {
            this.injectIsDesktop();
        } catch (e) {
            this.log.error(`injectIsDesktop failed: ${e.message}`);
            throw e;
        }
        this.$.electronApp.validationGatesPassed.push('injectIsDesktop');

        try {
            this.injectEsm();
        } catch (e) {
            this.log.error(`injectEsm failed: ${e.message}`);
            throw e;
        }

        try {
            this.changeDdpUrl();
        } catch (e) {
            this.log.error(`changeDdpUrl failed: ${e.message}`);
            throw e;
        }

        try {
            await this.packToAsar();
        } catch (e) {
            this.log.error('error while packing meteor app to asar');
            throw e;
        }

        try {
            this.validateMeteorAsar();
        } catch (e) {
            this.log.error(`A3 meteor asar validation failed: ${e.message}`);
            throw e;
        }
        this.$.electronApp.validationGatesPassed.push('A3 meteor asar');

        this.log.info('meteor build finished');

        if (this.mobilePlatform) {
            await this.removeMobilePlatform(this.mobilePlatform);
        }
    }

    changeDdpUrl() {
        if (this.$.env.options.ddpUrl !== null) {
            try {
                this.updateDdpUrl(this.$.env.paths.electronApp.meteorAppIndex);
            } catch (e) {
                this.log.error(`error while trying to change the ddp url: ${e.message}`);
                throw e;
            }
        }
    }

    packToAsar() {
        this.log.info('packing meteor app to asar archive');
        return new Promise((resolve, reject) => asar.createPackage(
            this.$.env.paths.electronApp.meteorApp,
            path.join(this.$.env.paths.electronApp.root, 'meteor.asar')
        )
            .then(() => {
                // On Windows some files might still be blocked. Giving a tick for them to be
                // ready for deletion.
                setImmediate(() => {
                    this.log.verbose('clearing meteor app after packing');
                    this.$.utils
                        .rmWithRetries('-rf', this.$.env.paths.electronApp.meteorApp)
                        .then(() => {
                            resolve();
                        })
                        .catch((e) => {
                            reject(e);
                        });
                });
            }));
    }

    /**
     * A3: Validates the packed meteor.asar content.
     * Checks that index.html has the setImmediate polyfill and that JS files in packages/
     * have no unpatched 'var global = this' or 'import.meta' patterns left behind by injectEsm.
     */
    validateMeteorAsar() {
        const asarPath = path.join(this.$.env.paths.electronApp.root, 'meteor.asar');
        if (!fs.existsSync(asarPath)) {
            throw new Error('A3: meteor.asar not found — packToAsar() should have exited; build state is corrupt');
        }

        const allFiles = asar.listPackage(asarPath);

        // Check index.html has setImmediate polyfill (confirms injectEsm ran)
        const indexFile = allFiles.find((f) => f === '/index.html' || f === 'index.html');
        if (!indexFile) {
            throw new Error('A3: meteor.asar — index.html not found in archive; packToAsar or copyBuild may have failed');
        } else {
            const indexHtml = asar.extractFile(asarPath, indexFile.replace(/^\//, '')).toString('UTF-8');
            if (!indexHtml.includes('window.setImmediate')) {
                throw new Error('A3: meteor.asar index.html missing setImmediate polyfill — injectEsm did not run or was skipped');
            } else {
                this.log.info('A3: meteor.asar index.html has setImmediate polyfill — OK');
            }
            if (indexHtml.includes('type="module"') || indexHtml.includes("type='module'")) {
                throw new Error(
                    'A3: meteor.asar index.html has type=module scripts — '
                    + 'this breaks bare global assignments; injectEsm must not add type=module. '
                    + 'Check updateDdpUrl() and any other HTML post-processors.'
                );
            }
        }

        // Check JS files in packages/ AND root-level for residual unpatched patterns
        const packageJsFiles = allFiles.filter((f) => f.startsWith('/packages/') && f.endsWith('.js'));
        const rootJsFiles = allFiles.filter(
            (f) => !f.startsWith('/packages/') && !f.startsWith('/app/') && f.endsWith('.js')
        );
        const residual = [];

        packageJsFiles.forEach((f) => {
            const content = asar.extractFile(asarPath, f.replace(/^\//, '')).toString('UTF-8');
            if (
                content.includes('var global = this;')
                || content.match(/\}\)\.call\(this\)(?!\s*\|\|)/)
            ) {
                residual.push(f);
            }
        });

        rootJsFiles.forEach((f) => {
            const content = asar.extractFile(asarPath, f.replace(/^\//, '')).toString('UTF-8');
            const barePackageAssignRegex = /^([a-zA-Z0-9_$]+)\s*=\s*(Package[.[].*)/m;
            if (
                content.includes('var global = this;')
                || content.match(/\}\)\.call\(this\)(?!\s*\|\|)/)
                || content.match(barePackageAssignRegex)
            ) {
                residual.push(f);
            }
        });

        if (residual.length > 0) {
            throw new Error(
                `A3: meteor.asar — ${residual.length} JS file(s) with unpatched ESM patterns:`
                + ` ${residual.join(', ')}`
            );
        } else {
            this.log.info(
                `A3: meteor.asar — ${packageJsFiles.length} packages/ + ${rootJsFiles.length} root JS file(s) checked,`
                + ' no unpatched global patterns'
            );
        }
    }

    /**
     * Wrapper for spawning npm.
     * @param {Array}  commands - commands for spawn
     * @param {string} stdio
     * @param {string} cwd
     * @return {Promise}
     */
    runNpm(commands, stdio = 'ignore', cwd = this.$.env.paths.meteorApp.root) {
        return new Promise((resolve, reject) => {
            this.log.verbose(`executing meteor npm ${commands.join(' ')}`);

            spawn('meteor', ['npm', ...commands], {
                cwd,
                stdio
            }).on('exit', (code) => (
                (code === 0) ? resolve() : reject(new Error(`npm exit code was ${code}`))
            ));
        });
    }
}
