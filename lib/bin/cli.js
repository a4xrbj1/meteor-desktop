#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { program } from 'commander';

// eslint-disable-next-line import-x/no-rename-default, import-x/no-useless-path-segments
import meteorDesktop from '../index.js';
import addScript from '../scripts/utils/addScript.js';

const { join } = path;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const meteorDesktopVersion = JSON.parse(
    fs.readFileSync(path.resolve(path.join(currentDir, '..', '..', 'package.json')), 'utf-8')
).version;

const {
    log, error, info, warn
} = console;

/**
 * Looks for .meteor directory.
 * @param {string} appPath - Meteor app path
 */
function isMeteorApp(appPath) {
    const meteorPath = join(appPath, '.meteor');
    try {
        return fs.statSync(meteorPath).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Just ensures a ddp url is set.
 *
 * @param {string|null} ddpUrl - the url that Meteor app connects to
 * @returns {string|null}
 */

function getDdpUrl(ddpUrl = null) {
    const opts = program.opts();
    if (!ddpUrl && opts.buildMeteor) {
        info('no ddp_url specified, setting default: http://127.0.0.1:3000');
        return 'http://127.0.0.1:3000';
    }
    return ddpUrl;
}

// --------------------------

function collect(val, memo) {
    memo.push(val);
    return memo;
}

/**
 * Registers all global CLI options, usage, version and help output on a commander program.
 *
 * @param {import('commander').Command} prog - the commander program to configure
 */
function addOptions(prog) {
    prog
        .option('-b, --build-meteor', 'runs meteor to obtain the mobile build, kills it after')
        .option('-t, --build-timeout <timeout_in_sec>', 'timeout value when waiting for '
            + 'meteor to build, default 600sec')
        .option('-p, --port <port>', 'port on which meteor is running, when with -b this will be passed to meteor '
            + 'when obtaining the build')
        .option('--production', 'builds meteor app with the production switch, uglifies contents '
            + 'of .desktop, packs app to app.asar')
        .option('-a, --android', 'force adding android as a mobile platform instead of ios')
        .option('-s, --scaffold', 'will scaffold .desktop if not present')
        .option('-i, --ignore-stderr [string]',
            'only with -b, strings that when found will not terminate meteor build',
            collect,
            [])
        .option('--meteor-settings <path>', 'only with -b, adds --settings options to meteor')
        .option('--prod-debug', 'forces adding dev tools to a production build')
        .option('--ia32', 'generate 32bit installer/package')
        .option('--all-archs', 'generate 32bit and 64bit installers')
        .option('--win', 'generate Windows installer')
        .option('--linux', 'generate Linux installer')
        .option('--mac', 'generate Mac installer')
        .option('-d, --debug', 'run electron with debug switch')
        .option('--remote-debugging-port <port>', 'run electron with remote debugging port');

    prog
        .usage('[command] [options]')
        .version(meteorDesktopVersion, '-V, --version')
        .on('--help', () => {
            log('  [ddp_url] - pass a ddp url if you want to use a different one than the default');
            log('              this will also work with -b');
            log('    ');
            log('  Examples:');
            log('');
            log(
                '   ',
                [
                    '# cd into meteor dir first',
                    'cd /your/meteor/app',
                    'meteor',
                    '',
                    '# open new terminal, assuming you have done npm install --save-dev @a4xrbj1/meteor-desktop',
                    'npm run desktop -- init',
                    'npm run desktop'
                ].join('\n    ')
            );
            log('\n');
        });
}

function verifyArgsSyntax() {
    if (process.env.npm_config_argv) {
        let npmArgv;
        try {
            const args = ['-b', '--build-meteor', '-t', '--build-timeout', '-p', '--port',
                '--production', '-a', '--android', '-s', '--scaffold', '--ia32', '--win',
                '--linux', '--all-archs', '--win', '--mac', '--meteor-settings'];
            npmArgv = JSON.parse(process.env.npm_config_argv);
            if (npmArgv.remain.length === 0 && npmArgv.original.length > 2) {
                if (npmArgv.original.some((arg) => !!~args.indexOf(arg))) {
                    warn('WARNING: seems that you might used the wrong console syntax, no ` --'
                        + ' ` delimiter was found, be sure you are invoking meteor-desktop with'
                        + ' it when passing commands or options -> '
                        + '`npm run desktop -- command --option`\n');
                }
            }
        } catch {
            // Not sure if `npm_config_argv` is always present...
        }
    }
}

function meteorDesktopFactory(ddpUrl, production = false) {
    info(`METEOR-DESKTOP v${meteorDesktopVersion}\n`);

    verifyArgsSyntax();

    const input = process.cwd();
    const opts = program.opts();

    if (!isMeteorApp(input)) {
        error(`not in a meteor app dir\n ${input}`);
        process.exit();
    }

    if (!opts.output) {
        opts.output = input;
    }

    if (production && !opts.production) {
        info('package/build-installer implies setting --production, setting it for you');
    }

    if (!opts.buildMeteor) {
        opts.port = opts.port || 3000;
        info(`REMINDER: your Meteor project should be running now on port ${opts.port}\n`);
    }

    if (opts.prodDebug) {
        info('!! WARNING: You are adding devTools to a production build !!\n');
    }

    const options = {
        ddpUrl,
        skipMobileBuild: opts.buildMeteor ? !opts.buildMeteor : true,
        production: opts.production || production
    };

    Object.assign(options, opts);

    return meteorDesktop(
        input,
        opts.output,
        options
    );
}

function run(ddpUrl) {
    meteorDesktopFactory(getDdpUrl(ddpUrl)).run();
}

function build(ddpUrl) {
    meteorDesktopFactory(getDdpUrl(ddpUrl)).build();
}

function init() {
    meteorDesktopFactory().init();
}

function justRun() {
    meteorDesktopFactory().justRun();
}

function runPackager(ddpUrl) {
    meteorDesktopFactory(getDdpUrl(ddpUrl), true).runPackager();
}

function buildInstaller(ddpUrl) {
    meteorDesktopFactory(getDdpUrl(ddpUrl), true).buildInstaller();
}

function initTestsSupport() {
    log('installing @playwright/test and playwright');
    log('running `meteor npm install --save-dev @playwright/test playwright`');

    let installFailed = false;
    try {
        const installCmd = 'meteor npm install --save-dev @playwright/test playwright';
        execSync(installCmd, { stdio: 'inherit' });
    } catch {
        installFailed = true;
    }

    if (installFailed) {
        warn('could not add @playwright/test and playwright to your `devDependencies`, please do it'
            + ' manually');
    }

    const test = 'playwright test';
    const testWatch = 'playwright test --ui';

    function fail() {
        error('\ncould not add entries to `scripts` in package.json');
        log('please try to add it manually\n');
        log(`test-desktop: ${test}`);
        log(`test-desktop-watch: ${testWatch}`);
    }

    const packageJsonPath = path.resolve(
        path.join(process.cwd(), 'package.json')
    );

    addScript('test-desktop', test, packageJsonPath, fail);
    addScript('test-desktop-watch', testWatch, packageJsonPath, fail);

    log('\nadded test-desktop and test-desktop-watch entries');
    log('run the test with `npm run test-desktop`');
}

/**
 * Registers every subcommand on a commander program. `run` is the default command, so an
 * invocation that supplies no subcommand token (regardless of where global options appear)
 * dispatches `run`. This replaces the former hand-rolled argv prefix-rewriter, which only
 * inspected argv[2] and mis-routed `<options> build` to `run` with ddp_url='build'.
 *
 * @param {import('commander').Command} prog - the commander program to configure
 * @param {Object} handlers - map of action handlers keyed by command name
 */
function registerCommands(prog, handlers) {
    prog
        .command('init')
        .description('scaffolds .desktop dir in the meteor app')
        .action(handlers.init);

    prog
        .command('run [ddp_url]', { isDefault: true })
        .description('(default) builds and runs desktop app')
        .action(handlers.run);

    prog
        .command('build [ddp_url]')
        .description('builds your desktop app')
        .action(handlers.build);

    prog
        .command('build-installer [ddp_url]')
        .description('creates the installer')
        .action(handlers.buildInstaller);

    prog
        .command('just-run')
        .description('alias for running `electron .` in `.meteor/desktop-build`')
        .action(handlers.justRun);

    prog
        .command('package [ddp_url]')
        .description('runs electron packager')
        .action(handlers.runPackager);

    prog
        .command('init-tests-support')
        .description('prepares project for running functional tests of desktop app')
        .action(handlers.initTestsSupport);
}

const actions = {
    init, run, build, buildInstaller, justRun, runPackager, initTestsSupport
};

// Compare realpaths: when invoked via a node_modules/.bin symlink, import.meta.url is the
// resolved realpath while process.argv[1] keeps the symlink path, so a raw URL compare is false.
const isMain = fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
    addOptions(program);
    registerCommands(program, actions);
    program.parse(process.argv);
}

export { addOptions, registerCommands, actions };
