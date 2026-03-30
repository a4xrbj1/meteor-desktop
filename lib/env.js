import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const { join } = path;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @class
 * @property {packagePaths} paths
 */
export default class Env {
    constructor(input, output, options) {
        this.options = options;
        // Use a dedicated Meteor local dir so the desktop/Electron build does
        // not stomp on a concurrently running dev server's .meteor/local/.
        // This prevents race conditions where the production build deletes
        // debugOnly source maps or overwrites rspack entry-point env vars
        // mid-rebuild.  The name must differ from electronApp.rootName
        // ('desktop-build') to avoid overlapping directories.
        const meteorLocalDirSetting = path.join('.meteor', 'local-desktop');
        process.env.METEOR_LOCAL_DIR = meteorLocalDirSetting;

        if (this.isProductionBuild()) {
            process.env.NODE_ENV = 'production';
        }

        this.sys = {
            platform: process.platform,
            arch: process.arch
        };

        // Operational System.
        this.os = {
            isWindows: (process.platform === 'win32'),
            isLinux: (process.platform === 'linux'),
            isOsx: (process.platform === 'darwin')

        };
        this.stdio = 'inherit';

        this.os.name = (this.sys.platform === 'darwin' ? 'osx' : this.sys.platform);
        this.os.home = process.env[(this.os.isWindows ? 'USERPROFILE' : 'HOME')];
        this.os.tmp = os.tmpdir();

        /** @type {packagePaths} */
        this.paths = {};

        /** @type {meteorDesktopPaths} */
        this.paths.meteorDesktop = {
            root: path.resolve(__dirname, '..')
        };

        this.paths.meteorDesktop.skeleton = join(this.paths.meteorDesktop.root, 'skeleton');

        /** @type {meteorAppPaths} */
        this.paths.meteorApp = {
            root: input
        };

        this.paths.meteorApp.localDir = path.isAbsolute(meteorLocalDirSetting)
            ? meteorLocalDirSetting
            : join(this.paths.meteorApp.root, meteorLocalDirSetting);

        /** @type {desktopPaths} */
        this.paths.desktop = {
            rootName: '.desktop',
            root: join(this.paths.meteorApp.root, '.desktop')
        };

        Object.assign(this.paths.desktop, {
            modules: join(this.paths.desktop.root, 'modules'),
            import: join(this.paths.desktop.root, 'import'),
            assets: join(this.paths.desktop.root, 'assets'),
            settings: join(this.paths.desktop.root, 'settings.json'),
            desktop: join(this.paths.desktop.root, 'desktop.js')
        });

        this.paths.desktop.splashScreen = join(this.paths.desktop.assets, 'splashScreen.png');
        this.paths.desktop.loadingGif = join(this.paths.desktop.assets, 'loading.gif');
        this.paths.desktop.meteorIco = join(this.paths.desktop.assets, 'meteor.ico');

        /** @type {electronAppPaths} */
        this.paths.electronApp = {
            rootName: 'desktop-build',
        };
        this.paths.electronApp.root = join(this.paths.meteorApp.root, '.meteor', this.paths.electronApp.rootName);

        this.paths.electronApp.tmpNodeModules = join(this.paths.meteorApp.root, '.meteor', '.desktop_node_modules');

        this.paths.cache = join(this.paths.meteorApp.localDir, 'desktop-cache');

        this.paths.electronApp.extractedNodeModules = join(this.paths.meteorApp.root, '.meteor', '.desktop_extracted_node_modules');

        this.paths.electronApp.extractedNodeModulesBin = join(this.paths.electronApp.extractedNodeModules, '.bin');

        this.paths.electronApp.appRoot = join(this.paths.electronApp.root, 'app');

        Object.assign(this.paths.electronApp, {
            app: join(this.paths.electronApp.appRoot, 'app.js'),
            desktopHcp: join(this.paths.electronApp.appRoot, 'desktop-hcp.js'),
            index: join(this.paths.electronApp.appRoot, 'index.js'),
            preload: join(this.paths.electronApp.appRoot, 'preload.js'),
            modules: join(this.paths.electronApp.appRoot, 'modules'),
            desktopAsar: join(this.paths.electronApp.root, 'desktop.asar'),
            extracted: join(this.paths.electronApp.root, 'extracted'),
            appAsar: join(this.paths.electronApp.root, 'app.asar'),
            import: join(this.paths.electronApp.root, 'import'),
            assets: join(this.paths.electronApp.root, 'assets'),
            packageJson: join(this.paths.electronApp.root, 'package.json'),
            settings: join(this.paths.electronApp.root, 'settings.json'),
            desktop: join(this.paths.electronApp.root, 'desktop.js'),
            desktopTmp: join(this.paths.electronApp.root, '__desktop'),
            nodeModules: join(this.paths.electronApp.root, 'node_modules'),
            meteorAsar: join(this.paths.electronApp.root, 'meteor.asar'),
            meteorApp: join(this.paths.electronApp.root, 'meteor'),
            meteorAppIndex: join(this.paths.electronApp.root, 'meteor', 'index.html'),
            meteorAppProgramJson: join(this.paths.electronApp.root, 'meteor', 'program.json'),
            skeleton: join(this.paths.electronApp.root, 'skeleton')
        });

        Object.assign(this.paths.meteorApp, {
            platforms: join(this.paths.meteorApp.root, '.meteor', 'platforms'),
            packages: join(this.paths.meteorApp.root, '.meteor', 'packages'),
            versions: join(this.paths.meteorApp.root, '.meteor', 'versions'),
            release: join(this.paths.meteorApp.root, '.meteor', 'release'),
            packageJson: join(this.paths.meteorApp.root, 'package.json'),
            gitIgnore: join(this.paths.meteorApp.root, '.meteor', '.gitignore'),
            legacyBuild: join(
                this.paths.meteorApp.localDir,
                'cordova-build',
                'www',
                'application'
            ),
            webBrowser: join(
                this.paths.meteorApp.localDir,
                'build',
                'programs',
                'web.browser'
            )
        });

        Object.assign(this.paths.meteorApp, {
            legacyBuildIndex: join(
                this.paths.meteorApp.legacyBuild, 'index.html'
            ),
            legacyBuildProgramJson: join(
                this.paths.meteorApp.legacyBuild, 'program.json'
            )
        });

        Object.assign(this.paths.meteorApp, {
            webBrowserProgramJson: join(
                this.paths.meteorApp.webBrowser, 'program.json'
            )
        });

        /** @type {desktopTmpPaths} */
        this.paths.desktopTmp = {
            root: join(this.paths.electronApp.root, '__desktop'),
        };

        Object.assign(this.paths.desktopTmp, {
            modules: join(this.paths.desktopTmp.root, 'modules'),
            settings: join(this.paths.desktopTmp.root, 'settings.json')
        });

        this.paths.packageDir = '.desktop-package';
        this.paths.installerDir = '.desktop-installer';

        // Scaffold
        this.paths.scaffold = join(__dirname, '..', 'scaffold');
    }

    /**
     * @returns {boolean|*}
     * @public
     */
    isProductionBuild() {
        return !!('production' in this.options && this.options.production);
    }
}

/**
 * @typedef {Object} desktopPaths
 * @property {string} rootName
 * @property {string} root
 * @property {string} modules
 * @property {string} import
 * @property {string} assets
 * @property {string} settings
 * @property {string} desktop
 * @property {string} splashScreen
 * @property {string} loadingGif
 * @property {string} meteorIco
 */

/**
 * @typedef {Object} meteorAppPaths
 * @property {string} root
 * @property {string} platforms
 * @property {string} release
 * @property {string} packages
 * @property {string} versions
 * @property {string} gitIgnore
 * @property {string} packageJson
 * @property {string} localDir
 * @property {string} legacyBuild
 * @property {string} legacyBuildIndex
 * @property {string} legacyBuildProgramJson
 * @property {string} webBrowser
 * @property {string} webBrowserIndex
 * @property {string} webBrowserProgramJson
 */

/**
 * @typedef {Object} electronAppPaths
 * @property {string} rootName
 * @property {string} root
 * @property {Object} appRoot
 * @property {string} appRoot.desktopHcp
 * @property {string} appRoot.index
 * @property {string} appRoot.app
 * @property {string} appRoot.modules
 * @property {string} desktopAsar
 * @property {string} extracted
 * @property {string} appAsar
 * @property {string} preload
 * @property {string} import
 * @property {string} assets
 * @property {string} gitIgnore
 * @property {string} packageJson
 * @property {string} settings
 * @property {string} desktop
 * @property {string} desktopTmp
 * @property {string} nodeModules
 * @property {string} meteorAsar
 * @property {string} meteorApp
 * @property {string} meteorAppIndex
 * @property {string} meteorAppProgramJson
 * @property {string} skeleton
 * @property {string} tmpNodeModules
 * @property {string} extractedNodeModules
 * @property {string} extractedNodeModulesBin
 */

/**
 * @typedef {Object} desktopTmpPaths
 * @property {string} root
 * @property {string} modules
 * @property {string} settings
 */

/**
 * @typedef {Object} meteorDesktopPaths
 * @property {string} root
 * @property {string} skeleton
 */

/**
 * @typedef {Object} packagePaths
 * @property {meteorAppPaths} meteorApp
 * @property {desktopPaths} desktop
 * @property {electronAppPaths} electronApp
 * @property {desktopTmpPaths} desktopTmp
 * @property {meteorDesktopPaths} meteorDesktop
 * @property {string} packageDir
 * @property {string} scaffold
 */
