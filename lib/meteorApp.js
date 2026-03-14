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
                    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
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
                this.log.error(`wrong meteor version (${release}) in project - only `
                    + `${versionRange} is supported`);
            } else {
                this.log.error(`wrong meteor version (${release}) in project - only `
                    + `${versionRange} is supported for automatic meteor builds (you can always `
                    + 'try with `--skip-mobile-build` if you are using meteor >= 1.2.1');
            }
            process.exit(1);
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
                    process.exit(1);
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
     * @returns {boolean}
     */
    isBuildReady() {
        if (this.indexHTMLstrategy === this.indexHTMLStrategies.INDEX_FROM_LOCAL_BUILD) {
            return this.$.utils.exists(this.$.env.paths.meteorApp.legacyBuildIndex)
                && this.$.utils.exists(this.$.env.paths.meteorApp.legacyBuildProgramJson)
                && (
                    !this.oldManifest
                    || (this.oldManifest
                        && this.oldManifest !== fs.readFileSync(
                            this.$.env.paths.meteorApp.legacyBuildProgramJson, 'UTF-8'
                        )
                    )
                );
        }
        return this.$.utils.exists(this.$.env.paths.meteorApp.webBrowserProgramJson)
            && (
                !this.oldManifest
                || (this.oldManifest
                    && this.oldManifest !== fs.readFileSync(
                        this.$.env.paths.meteorApp.webBrowserProgramJson, 'UTF-8'
                    )
                )
            );
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
     * Meteor 3.x web.browser does not serve manifest.json over HTTP (that was
     * Cordova-only at /__cordova/manifest.json). The file is always present on
     * disk by the time isBuildReady() returns true.
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
                    // If so, then exit immediately.
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
            this.log.error(`error loading index.html file: ${e.message}`);
            process.exit(1);
        }
        if (!this.matcher.test(content)) {
            this.log.error('could not find runtime config in index file');
            process.exit(1);
        }

        try {
            const matches = content.match(this.matcher);
            runtimeConfig = JSON.parse(decodeURIComponent(matches[1]));
        } catch (e) {
            this.log.error('could not find runtime config in index file');
            process.exit(1);
        }

        if (this.$.env.options.ddpUrl.substr(-1, 1) !== '/') {
            this.$.env.options.ddpUrl += '/';
        }

        runtimeConfig.ROOT_URL = this.$.env.options.ddpUrl;
        runtimeConfig.DDP_DEFAULT_CONNECTION_URL = this.$.env.options.ddpUrl;

        // Robust type="module" injection for Meteor 3.x ESM support, excluding desktop-hcp.js
        content = content.replace(/<script type="text\/javascript" src="/g, '<script type="module" src="/');
        content = content.replace(/<script src="/g, '<script type="module" src="/');
        content = content.replace(/<script type="module" src="\/desktop-hcp\.js"/g, '<script src="/desktop-hcp.js"');

        content = content.replace(
            this.replacer, `$1"${encodeURIComponent(JSON.stringify(runtimeConfig))}"$3`
        );

        try {
            fs.writeFileSync(indexHtml, content);
        } catch (e) {
            this.log.error(`error writing index.html file: ${e.message}`);
            process.exit(1);
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

        // Because of various permission problems here we try to clear te path by clearing
        // all possible restrictions.
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
                let fileContents;
                // Hacky way of setting isDesktop.
                if (file.type === 'js') {
                    fileContents = fs.readFileSync(
                        join(this.$.env.paths.electronApp.meteorApp, file.path),
                        'UTF-8'
                    );
                    result = this.injector.processFileContents(fileContents);

                    ({ fileContents } = result);
                    injectedStartupDidComplete = result.injectedStartupDidComplete ? true : injectedStartupDidComplete;
                    injected = result.injected ? true : injected;

                    fs.writeFileSync(
                        join(this.$.env.paths.electronApp.meteorApp, file.path), fileContents
                    );
                }
            });

            if (!injected) {
                this.log.error('error injecting isDesktop global var.');
                process.exit(1);
            }
            if (!injectedStartupDidComplete) {
                this.log.error('error injecting isDesktop for startupDidComplete');
                process.exit(1);
            }
        } catch (e) {
            this.log.error('error occurred while injecting isDesktop: ', e);
            process.exit(1);
        }
        this.log.info('injected successfully');
    }

    /**
     * Patches Meteor 3.x for native ESM support in Electron.
     *
     * Meteor 3.x uses import.meta.url which requires ES modules. However, ES modules
     * have different scoping rules where `this` at the top level is undefined instead
     * of the global object. This breaks Meteor's core-runtime.js which uses
     * `var global = this;` to access the global object.
     *
     * This method applies two patches:
     * 1. Patches core-runtime.js to use `window` instead of `this` for the global object
     * 2. Converts script tags in index.html to type="module" for native ESM support
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
            const files = fs.readdirSync(packagesDir);
            let patchedCount = 0;

            files.forEach((file) => {
                if (file.endsWith('.js')) {
                    const filePath = path.join(packagesDir, file);
                    let content = fs.readFileSync(filePath, 'UTF-8');
                    let patched = false;

                    if (content.includes('var global = this;')) {
                        content = content.replace(/var global = this;/g, 'var global = window;');
                        patched = true;
                    }

                    // Handle "global = this;" (without var, seen in meteor.js)
                    if (content.match(/global\s*=\s*this;/)) {
                        content = content.replace(/global\s*=\s*this;/g, 'global = window;');
                        patched = true;
                    }

                    // Patch IIFE .call(this) -> .call(this || window)
                    if (content.match(/\}\)\.call\(this\)/)) {
                        content = content.replace(/\}\)\.call\(this\)/g, '}).call(this || window)');
                        patched = true;
                    }
                    if (content.match(/\}\.call\(this\)/)) {
                        content = content.replace(/\}\.call\(this\)/g, '}.call(this || window)');
                        patched = true;
                    }

                    if (patched) {
                        fs.writeFileSync(filePath, content);
                        patchedCount++;
                    }
                }
            });

            if (patchedCount > 0) {
                this.log.info(`patched ${patchedCount} files in packages/: fixed global assignments and IIFEs`);
            }
            totalJsPatchedCount += patchedCount;

            // PATCH: Fix strict mode global assignments in app/ directory (global-imports.js, app.js)
            const appDir = path.join(meteorAppDir, 'app');
            if (fs.existsSync(appDir)) {
                const appFiles = fs.readdirSync(appDir);
                let appPatchedCount = 0;

                appFiles.forEach((file) => {
                    if (file.endsWith('.js')) {
                        const filePath = path.join(appDir, file);
                        let content = fs.readFileSync(filePath, 'UTF-8');
                        let patched = false;

                        // 1a. Fix "typeof X === 'undefined' { X = ... }" pattern (e.g. geo = {})
                        // This handles libraries trying to be safe but failing strict mode assignment
                        // Matches: if (typeof geo === 'undefined') { geo = ...
                        const safeInitRegex = /if\s*\(\s*typeof\s+([a-zA-Z0-9_$]+)\s*===\s*['"]undefined['"]\s*\)\s*\{\s*\1\s*=/g;
                        if (content.match(safeInitRegex)) {
                            content = content.replace(safeInitRegex, "if (typeof window.$1 === 'undefined') { window.$1 =");
                            patched = true;
                        }

                        // 1b. Fix Global Assignments: "Name = Package..." -> "window.Name = Package..."
                        // Handles matching "Package." or "Package['...']"
                        const assignmentRegex = /^([a-zA-Z0-9_$]+)\s*=\s*(Package[.[].*)/gm;
                        if (content.match(assignmentRegex)) {
                            content = content.replace(assignmentRegex, 'window.$1 = $2');
                            patched = true;
                        }

                        // 2. Fix Bare Identifier Access: "var require = meteorInstall" -> "var require = window.meteorInstall"
                        if (content.includes('var require = meteorInstall')) {
                            content = content.replace(/var require = meteorInstall/g, 'var require = window.meteorInstall');
                            patched = true;
                        }

                        // Also handle strict mode "this" in app files if present
                        if (content.match(/\}\)\.call\(this\)/)) {
                            content = content.replace(/\}\)\.call\(this\)/g, '}).call(this || window)');
                            patched = true;
                        }

                        if (patched) {
                            fs.writeFileSync(filePath, content);
                            appPatchedCount++;
                        }
                    }
                });

                if (appPatchedCount > 0) {
                    this.log.info(`patched ${appPatchedCount} files in app/: fixed strict mode globals and meteorInstall`);
                }
                totalJsPatchedCount += appPatchedCount;
            }
            // PATCH: Fix root-level combined bundle (Meteor 3.x puts all package JS into a single
            // hash-named file at the meteorApp root, e.g. a1b2c3.js). This file is missed by the
            // packages/ and app/ scans above, so .call(this) patterns remain unpatched.
            const rootFiles = fs.readdirSync(meteorAppDir);
            let rootPatchedCount = 0;

            rootFiles.forEach((file) => {
                if (!file.endsWith('.js')) {
                    return;
                }
                const filePath = path.join(meteorAppDir, file);
                if (!fs.statSync(filePath).isFile()) {
                    return;
                }
                let content = fs.readFileSync(filePath, 'UTF-8');
                let patched = false;

                if (content.includes('var global = this;')) {
                    content = content.replace(/var global = this;/g, 'var global = window;');
                    patched = true;
                }

                if (content.match(/global\s*=\s*this;/)) {
                    content = content.replace(/global\s*=\s*this;/g, 'global = window;');
                    patched = true;
                }

                if (content.match(/\}\)\.call\(this\)/)) {
                    content = content.replace(/\}\)\.call\(this\)/g, '}).call(this || window)');
                    patched = true;
                }

                if (content.match(/\}\.call\(this\)/)) {
                    content = content.replace(/\}\.call\(this\)/g, '}.call(this || window)');
                    patched = true;
                }

                // Root-level bundle also contains Package creation: "Package = ..." bare assignments
                const rootAssignmentRegex = /^([a-zA-Z0-9_$]+)\s*=\s*(Package[.[].*)/gm;
                if (content.match(rootAssignmentRegex)) {
                    content = content.replace(rootAssignmentRegex, 'window.$1 = $2');
                    patched = true;
                }

                if (patched) {
                    fs.writeFileSync(filePath, content);
                    rootPatchedCount += 1;
                }
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
                    if (content.includes('var global = this;') || content.match(/\}\)\.call\(this\)(?!\s*\|\|)/)) {
                        residualErrors.push(filePath);
                    }
                });
            });
            fs.readdirSync(meteorAppDir).forEach((file) => {
                if (!file.endsWith('.js')) {
                    return;
                }
                const filePath = path.join(meteorAppDir, file);
                if (!fs.statSync(filePath).isFile()) {
                    return;
                }
                const content = fs.readFileSync(filePath, 'UTF-8');
                if (content.includes('var global = this;') || content.match(/\}\)\.call\(this\)(?!\s*\|\|)/)) {
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

        // PATCH 2: Convert script tags to type="module" for native ESM support
        // This enables import.meta.url to work in Meteor's modules.js
        // PATCH 2: Convert script tags to type="module" for native ESM support
        // This enables import.meta.url to work in Meteor's modules.js
        try {
            let htmlContent = fs.readFileSync(indexHtml, 'UTF-8');

            // Add type="module" to script tags with src attribute, excluding desktop-hcp.js
            // First, handle scripts with type="text/javascript"
            htmlContent = htmlContent.replace(
                /<script type="text\/javascript" src="([^"]+)"/g,
                (match, src) => {
                    if (src.includes('desktop-hcp.js')) {
                        return match; // Keep desktop-hcp.js as-is
                    }
                    return `<script type="module" src="${src}"`;
                }
            );

            // Then handle scripts without explicit type
            htmlContent = htmlContent.replace(
                /<script src="([^"]+)"/g,
                (match, src) => {
                    if (src.includes('desktop-hcp.js')) {
                        return match; // Keep desktop-hcp.js as-is
                    }
                    return `<script type="module" src="${src}"`;
                }
            );

            // PATCH 3: Inject setImmediate polyfill
            // ES modules don't have access to Node.js globals like setImmediate, which Meteor relies on.
            const setImmediatePolyfill = `<script>
// setImmediate polyfill for Meteor 3.x in native ESM
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
            this.log.info('converted script tags to type="module" for native ESM support');

            // VALIDATION: verify every script src references a file that exists on disk
            const srcRegex = /<script[^>]+src="([^"]+)"/g;
            const missingSrcs = [];
            const allSrcMatches = [...htmlContent.matchAll(srcRegex)];
            allSrcMatches.forEach((m) => {
                const src = m[1];
                if (!fs.existsSync(path.join(meteorAppDir, src))) {
                    missingSrcs.push(src);
                }
            });
            if (missingSrcs.length > 0) {
                throw new Error(`injectEsm: ${missingSrcs.length} script src(s) missing:\n${missingSrcs.join('\n')}`);
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

        this.injectIsDesktop();

        this.injectEsm();

        this.changeDdpUrl();

        try {
            await this.packToAsar();
        } catch (e) {
            this.log.error('error while packing meteor app to asar');
            process.exit(1);
        }

        this.validateMeteorAsar();

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
     * Checks that index.html has type=module scripts and that JS files in packages/
     * have no unpatched 'var global = this' patterns left behind by injectEsm.
     */
    validateMeteorAsar() {
        const asarPath = path.join(this.$.env.paths.electronApp.root, 'meteor.asar');
        if (!fs.existsSync(asarPath)) {
            this.log.warn('A3: meteor.asar not found — skipping validation');
            return;
        }

        const allFiles = asar.listPackage(asarPath);

        // Check index.html has type=module scripts
        const indexFile = allFiles.find((f) => f === '/index.html' || f === 'index.html');
        if (!indexFile) {
            this.log.warn('A3: meteor.asar — index.html not found in archive');
        } else {
            const indexHtml = asar.extractFile(asarPath, indexFile.replace(/^\//, '')).toString('UTF-8');
            if (!indexHtml.includes('type="module"') && !indexHtml.includes("type='module'")) {
                this.log.warn('A3: meteor.asar index.html has no type=module scripts — injectEsm may have failed');
            } else {
                this.log.info('A3: meteor.asar index.html has type=module scripts — OK');
            }
        }

        // Check JS files in packages/ for residual unpatched patterns
        const packageJsFiles = allFiles.filter((f) => f.startsWith('/packages/') && f.endsWith('.js'));
        const residual = [];
        packageJsFiles.forEach((f) => {
            const content = asar.extractFile(asarPath, f.replace(/^\//, '')).toString('UTF-8');
            if (content.includes('var global = this;')) {
                residual.push(f);
            }
        });

        if (residual.length > 0) {
            this.log.warn(
                `A3: meteor.asar — ${residual.length} JS file(s) with unpatched 'var global = this':`
                + ` ${residual.join(', ')}`
            );
        } else {
            this.log.info(
                `A3: meteor.asar packages/ — ${packageJsFiles.length} JS file(s) checked,`
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
