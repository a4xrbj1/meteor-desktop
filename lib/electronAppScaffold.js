import fs from 'fs';
import path from 'path';

import Log from './log.js';
import dependencies from './skeletonDependencies.js';

const { join } = path;

/**
 * Represents the .desktop dir scaffold.
 */
export default class ElectronAppScaffold {
    /**
     * @param {MeteorDesktop} $ - context
     * @constructor
     */
    constructor($) {
        this.log = new Log('electronAppScaffold');
        this.$ = $;

        this.packageJson = {
            name: 'MyMeteorApp',
            type: 'commonjs',
            main: (this.$.env.isProductionBuild())
                ? 'app.asar/index.js' : 'app/index.js',
            dependencies: { ...dependencies }
        };

        if (!this.$.env.isProductionBuild() || this.$.env.options.prodDebug) {
            this.packageJson.dependencies['electron-debug'] = '1.5.0';
        }
    }

    /**
     * Just a public getter from the default package.json object.
     * @returns {Object}
     */
    getDefaultPackageJson() {
        return { ...this.packageJson };
    }

    /**
     * Clear the electron app. Removes everything except the node_modules which would be a waste
     * to delete. Later `npm prune` will keep it clear.
     */
    clear() {
        if (!this.$.utils.exists(this.$.env.paths.electronApp.root)) {
            this.log.verbose(`creating ${this.$.env.paths.electronApp.rootName}`);
            fs.mkdirSync(this.$.env.paths.electronApp.root, { recursive: true });
        }

        fs.readdirSync(this.$.env.paths.electronApp.root).forEach((entry) => {
            const full = path.join(this.$.env.paths.electronApp.root, entry);
            if (full !== this.$.env.paths.electronApp.nodeModules) {
                fs.rmSync(full, {
                    recursive: true, force: true, maxRetries: 3, retryDelay: 150
                });
            }
        });
    }

    /**
     * Just copies the Skeleton App into the electron app.
     */
    copySkeletonApp() {
        this.log.verbose('copying skeleton app');
        try {
            const src = join(this.$.env.paths.meteorDesktop.skeleton);
            const dest = this.$.env.paths.electronApp.appRoot;
            fs.readdirSync(src).forEach((item) => {
                fs.cpSync(path.join(src, item), path.join(dest, item), { recursive: true, force: true });
            });
        } catch (e) {
            this.log.error('error while copying skeleton app:', e);
            process.exit(1);
        }
    }

    /**
     * After clearing the electron app path, copies a fresh skeleton.
     */
    async make() {
        try {
            this.log.verbose(`clearing ${this.$.env.paths.electronApp.rootName}`);
            await this.clear();
        } catch (e) {
            this.log.error(
                `error while removing ${this.$.env.paths.electronApp.root}: `, e
            );
            process.exit(1);
        }

        this.createAppRoot();

        this.copySkeletonApp();

        // TODO: hey, wait, .gitignore is not needed - right?
        /*
        this.log.debug('creating .gitignore');
        fs.writeFileSync(this.$.env.paths.electronApp.gitIgnore, [
            'node_modules'
        ].join('\n'));
        */
        this.log.verbose('writing package.json');
        fs.writeFileSync(
            this.$.env.paths.electronApp.packageJson, JSON.stringify(this.packageJson, null, 2)
        );
    }

    /**
     * Creates the app directory in the electron app.
     */
    createAppRoot() {
        try {
            this.log.verbose(`creating ${this.$.env.paths.electronApp.appRoot}`);
            fs.mkdirSync(this.$.env.paths.electronApp.appRoot);
        } catch (e) {
            if (e.code !== 'EEXIST') {
                this.log.error(
                    `error while creating dir: ${this.$.env.paths.electronApp.appRoot}: `, e
                );
                process.exit(1);
            }
        }
    }
}
