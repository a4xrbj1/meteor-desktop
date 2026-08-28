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

        // A scripted launch cannot otherwise tell a clean quit from a crash: without this the CLI
        // exits 0 whatever Electron did, which defeats the whole point of `just-run` (seed
        // meteor-desktop-a8f8). exitCode rather than exit() for the same reason as the spawn error
        // above — process.exit truncates a piped stdout, and the app's own output is what a smoke
        // launch is reading.
        child.on('exit', (code, signal) => {
            if (signal !== null) {
                // Killed rather than exited, so there is no code to forward. Reported as a failure
                // because a launch that had to be killed is not a successful one.
                this.log.error(`electron was terminated by signal ${signal}`);
                process.exitCode = 1;
                return;
            }
            if (code === null) {
                // Node's child_process docs say 'exit' "may or may not fire after an 'error' has
                // occurred", and in that case both arguments are null. Measured not to fire on
                // Node 24 here — but assigning a null code would set process.exitCode to unset,
                // i.e. 0, silently undoing the spawn-error exit code set just above (seed
                // meteor-desktop-86d2). There is nothing to forward, so forward nothing.
                return;
            }
            if (code !== 0) {
                this.log.error(`electron exited with code ${code}`);
            }
            process.exitCode = code;
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
