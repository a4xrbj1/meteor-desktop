import spawn from 'cross-spawn';

import Log from './log.js';
import defaultDependencies from './defaultDependencies.js';

/**
 * Simple Electron runner. Runs the project with the bin provided by the 'electron' package.
 * @class
 */
export default class Electron {
    constructor($) {
        this.log = new Log('electron');
        this.$ = $;
    }

    async init() {
        this.electron = await this.$.getDependency('electron', defaultDependencies.electron);
    }

    run() {
        const env = { ...process.env };
        env.ELECTRON_ENV = 'development';
        delete env.ELECTRON_RUN_AS_NODE; // CRITICAL: Ensure full Electron mode

        const cmd = [];

        if (this.$.env.options.debug) {
            cmd.push('--debug=5858');
        }

        if (this.$.env.options.remoteDebuggingPort) {
            cmd.push(`--remote-debugging-port=${this.$.env.options.remoteDebuggingPort}`);
        }

        cmd.push('.');

        const child = spawn(this.electron.dependency, cmd, {
            cwd: this.$.env.paths.electronApp.root,
            env
        });

        // ponytail: exitCode, not exit(1) - process.exit truncates a piped stdout, which is exactly
        // the scripted smoke-launch case; nothing holds the loop open after a failed spawn.
        child.on('error', (e) => {
            this.log.error(`could not spawn electron in ${this.$.env.paths.electronApp.root} `
                + `(${e.message}) - if the app was never built, run \`meteor-desktop build\` first`);
            process.exitCode = 1;
        });

        // TODO: check if we can configure piping in spawn options
        child.stdout.on('data', (chunk) => {
            process.stdout.write(chunk);
        });
        child.stderr.on('data', (chunk) => {
            process.stderr.write(chunk);
        });
    }
}
