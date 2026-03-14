/* eslint-disable import-x/no-unresolved,no-console */
/* eslint-disable global-require, import-x/no-dynamic-require */

import { EventEmitter as Events } from 'events';
import path from 'path';
import { createRequire } from 'module';
import fs from 'fs-plus';
import Module from './modules/module.js';
import LoggerManager from './loggerManager.js';
import DesktopPathResolver from './desktopPathResolver.js';
import WindowSettings from './windowSettings.js';
import Squirrel from './squirrel.js';

const require = createRequire(import.meta.url);

let electron = {
    app: {},
    BrowserWindow: class BrowserWindow { },
    dialog: {},
    net: { fetch: Function.prototype },
    protocol: {
        registerStandardSchemes: Function.prototype,
        registerSchemesAsPrivileged: Function.prototype
    }
};
try {
    electron = require('electron');
} catch (e) {
    // Allows unit tests to run outside Electron.
}

const {
    app, BrowserWindow, dialog, net, protocol
} = electron;
const { join } = path;

/**
 * This is the main app which is a skeleton for the whole integration.
 * Here all the plugins/modules are loaded, local server is spawned and autoupdate is initialized.
 * @class
 */
export default class App {
    constructor() {
        this.startup = true;
        console.time('startup took');

        electron.protocol.registerSchemesAsPrivileged([
            {
                scheme: 'meteor',
                privileges: {
                    standard: true, secure: true, supportFetchAPI: true, stream: true
                }
            }
        ]);

        // Until user defined handling will be loaded it is good to register something
        // temporarily.
        this.catchUncaughtExceptions();

        this.getOsSpecificValues();

        this.loggerManager = new LoggerManager(this);
        this.l = this.loggerManager.getMainLogger();

        this.l.info('app data dir is:', this.userDataDir);

        this.settings = {
            devTools: false
        };

        this.desktopPath = DesktopPathResolver.resolveDesktopPath(this.userDataDir, this.l);
        this.loadSettings();

        if ('meteorDesktopVersion' in this.settings) {
            this.l.debug(`skeleton version ${this.settings.meteorDesktopVersion}`);
        }

        this.window = null;

        this.applySingleInstance();

        // To make desktop.asar's downloaded through HCP work, we need to provide them a path to
        // node_modules.
        const nodeModulesPath = [__dirname, 'node_modules'];

        // TODO: explain this
        if (!this.isProduction()) {
            nodeModulesPath.splice(1, 0, '..');
        }

        const GlobalModule = require('module');
        const absoluteNodeModulesPath = path.resolve(join(...nodeModulesPath));
        // for electron 16 or lower
        GlobalModule.globalPaths.push(absoluteNodeModulesPath);
        // for electron 17 or higher
        // eslint-disable-next-line no-underscore-dangle
        const nodeModulePaths = GlobalModule._nodeModulePaths;
        // eslint-disable-next-line no-underscore-dangle
        GlobalModule._nodeModulePaths = (from) => nodeModulePaths(from).concat([absoluteNodeModulesPath]);

        /**
         * DEPRECATED
         */
        if (Squirrel.handleSquirrelEvents(this.desktopPath)) {
            app.quit();
            return;
        }

        // This is needed for OSX - check Electron docs for more info.
        if ('builderOptions' in this.settings && this.settings.builderOptions.appId) {
            app.setAppUserModelId(this.settings.builderOptions.appId);
        }

        // System events emitter.
        this.eventsBus = new Events();

        this.desktop = null;
        this.app = app;
        this.windowAlreadyLoaded = false;
        this.webContents = null;
        this.modules = {};
        this.localServer = null;
        this.currentPort = null;

        if (this.isProduction() && !this.settings.prodDebug) {
            // In case anything depends on this...
            process.env.NODE_ENV = 'production';
        } else {
            require('electron-debug')({
                showDevTools: process.env.ELECTRON_ENV !== 'test',
                enabled: (this.settings.devTools !== undefined) ? this.settings.devTools : true
            });
        }

        this.prepareWindowSettings();

        this.meteorAppVersionChange = false;
        this.pendingDesktopVersion = null;
        this.eventsBus.on('newVersionReady', (version, desktopVersion) => {
            this.l.debug(`received newVersionReady ${desktopVersion ? '(desktop update present)' : ''}`);
            this.meteorAppVersionChange = true;
            this.pendingDesktopVersion = desktopVersion;
        });
        this.eventsBus.on('startupDidComplete', this.handleAppStartup.bind(this, true));
        this.eventsBus.on('revertVersionReady', () => { this.meteorAppVersionChange = true; });

        this.app.on('ready', this.onReady.bind(this));
        this.app.on('window-all-closed', () => this.app.quit());
    }

    /**
     * Applies single instance mode if enabled.
     */
    applySingleInstance() {
        if ('singleInstance' in this.settings && this.settings.singleInstance) {
            this.l.verbose('setting single instance mode');

            const isFirstInstance = app.requestSingleInstanceLock();

            if (!isFirstInstance) {
                this.l.warn('current instance was terminated because another instance is running');
                app.quit();
            } else {
                app.on('second-instance', () => {
                    // Someone tried to run a second instance, we should focus our window.
                    if (this.window) {
                        if (this.window.isMinimized()) {
                            this.window.restore();
                            this.window.focus();
                        } else {
                            this.window.show();
                        }
                    }
                });
            }
        }
    }

    /**
     * Prepares all the values that are dependant on os.
     */
    getOsSpecificValues() {
        this.os = {
            isWindows: (process.platform === 'win32'),
            isLinux: (process.platform === 'linux'),
            isOsx: (process.platform === 'darwin')
        };

        this.userDataDir = app.getPath('userData');
    }

    /**
     * Checks whether this is a production build.
     * @returns {boolean}
     * @api
     */
    isProduction() {
        return ('env' in this.settings && this.settings.env === 'prod');
    }

    /**
     * Tries to load the settings.json.
     */
    loadSettings() {
        try {
            this.settings = JSON.parse(
                fs.readFileSync(join(this.desktopPath, 'settings.json')), 'UTF-8'
            );
        } catch (e) {
            this.l.error(e);
            dialog.showErrorBox('Application', 'Could not read settings.json. Please reinstall'
                + ' this application.');

            if (this.app && this.app.quit) {
                this.app.quit();
            }
            process.exit(1);
        }
    }

    /**
     * Removes default uncaught exception listener.
     * But still leaves logging and emitting
     * @api
     */
    removeUncaughtExceptionListener() {
        process.removeListener('uncaughtException', this.uncaughtExceptionHandler);
    }

    /**
     * Logs the error and emits an unhandledException event on the events bus.
     * @param error
     */
    emitErrorAndLogIt(error) {
        try {
            this.l.error(error);
            if (this.eventsBus) {
                this.emit('unhandledException', error);
            }
        } catch (e) {
            // Well...
        }
    }

    /**
     * Register on uncaughtExceptions so we can handle them.
     */
    catchUncaughtExceptions() {
        this.uncaughtExceptionHandler = this.uncaughtExceptionHandler.bind(this);
        process.on('uncaughtException', this.emitErrorAndLogIt.bind(this));
        process.on('uncaughtException', this.uncaughtExceptionHandler);
    }

    /**
     * Default uncaught exception handler.
     */
    uncaughtExceptionHandler() {
        try {
            this.window.close();
        } catch (e) {
            // Empty catch block... nasty...
        }
        setTimeout(() => {
            dialog.showErrorBox('Application', 'Internal error occurred. Restart this '
                + 'application. If the problem persists, contact support or try to reinstall.');
            this.app.quit();
        }, 500);
    }

    /**
     * Applies dev, os specific and variables to window settings.
     */
    prepareWindowSettings() {
        if (!('window' in this.settings)) {
            this.settings.window = {};
        }
        if (!this.isProduction()) {
            WindowSettings.mergeWindowDevSettings(this.settings);
        }
        WindowSettings.mergeOsSpecificWindowSettings(this.settings, this.os);
        WindowSettings.applyVars(this.settings.window, this.desktopPath);
    }

    /**
     * Loads and initializes all plugins listed in settings.json.
     */
    loadPlugins() {
        if ('plugins' in this.settings) {
            Object.keys(this.settings.plugins).forEach((plugin) => {
                try {
                    this.l.debug(`loading plugin: ${plugin}`);
                    this.modules[plugin] = require(plugin).default;

                    const Plugin = this.modules[plugin];

                    this.modules[plugin] = new Plugin({
                        log: this.loggerManager.configureLogger(plugin),
                        skeletonApp: this,
                        appSettings: this.settings,
                        eventsBus: this.eventsBus,
                        modules: this.modules,
                        settings: typeof this.settings.plugins[plugin] === 'object'
                            ? this.settings.plugins[plugin] : {},
                        Module
                    });
                } catch (e) {
                    // TODO: its probably safer not to exit here
                    // but a strategy for handling this would be better.
                    this.l.error(`error while loading plugin: ${e}`);
                }
            });
        }
    }

    /**
     * Loads and initializes internal and app modules.
     */
    loadModules() {
        // Load internal modules. Scan for files in /modules.
        const modulesDir = join(__dirname, 'modules');
        fs.readdirSync(modulesDir)
            .filter((f) => f.endsWith('.js'))
            .map((f) => join(modulesDir, f))
            .forEach((file) => {
                if (!~file.indexOf('module.js')) {
                    this.loadModule(true, file);
                }
            });

        // Now go through each directory in .desktop/modules.
        let moduleDirectories = [];
        try {
            moduleDirectories = fs.readdirSync(join(this.desktopPath, 'modules'));
        } catch (err) {
            if (err.code === 'ENOENT') {
                this.l.debug('not loading custom app modules because .desktop/modules isn\'t a directory');
            } else {
                throw err;
            }
        }

        moduleDirectories.forEach((dirName) => {
            try {
                const modulePath = join(this.desktopPath, 'modules', dirName);
                if (fs.lstatSync(modulePath).isDirectory()) {
                    this.loadModule(false, modulePath, dirName);
                }
            } catch (e) {
                this.l.error(`error while trying to load module in dir ${dirName}: ${e}`);
                this.l.debug(e.stack);
                this.emit('moduleLoadFailed', dirName);
            }
        });
    }

    /**
     * Tries to read a module's module.json file.
     * @param modulePath
     * @returns {{settings: {}, moduleName: *}}
     */
    static readModuleConfiguration(modulePath) {
        let settings = {};
        let moduleName = null;
        const moduleJson = JSON.parse(
            fs.readFileSync(path.join(modulePath, 'module.json'), 'UTF-8')
        );
        if ('settings' in moduleJson) {
            ({ settings } = moduleJson);
        }
        if ('name' in moduleJson) {
            moduleName = moduleJson.name;
        }
        // Inject extractedFilesPath.
        if ('extract' in moduleJson) {
            settings.extractedFilesPath = join(__dirname, '..', 'extracted', moduleName);
        }
        return { settings, moduleName };
    }

    /**
     * Load a module.
     * @param {boolean} internal   - whether that is an internal module
     * @param {string}  modulePath - path to the module
     * @param {string}  dirName    - directory name of the module
     */
    loadModule(internal, modulePath, dirName = '') {
        let moduleName = path.parse(modulePath).name;
        let settings = {};
        let indexPath;

        if (!internal) {
            // module.json is mandatory, but we can live without it.
            try {
                const result = App.readModuleConfiguration(modulePath);
                Object.assign(settings, result.settings);
                if (result.moduleName) {
                    ({ moduleName } = result);
                }
            } catch (e) {
                this.l.warn(`could not load ${path.join(modulePath, 'module.json')}`);
            }
            this.l.debug(`loading module: ${dirName} => ${moduleName}`);
            indexPath = path.join(modulePath, 'index.js');
        } else {
            this.l.debug(`loading internal module: ${moduleName}`);
            indexPath = modulePath;
        }

        const AppModule = require(indexPath).default;

        if (internal && moduleName === 'autoupdate') {
            settings = this.prepareAutoupdateSettings();
        }
        if (internal && moduleName === 'localServer') {
            settings = {
                localFilesystem: this.settings.exposeLocalFilesystem,
                allowOriginLocalServer: this.settings.allowOriginLocalServer || false
            };
        }

        this.modules[moduleName] = new AppModule({
            log: this.loggerManager.configureLogger(moduleName),
            skeletonApp: this,
            appSettings: this.settings,
            eventsBus: this.eventsBus,
            modules: this.modules,
            settings,
            Module
        });
    }

    /**
     * Tries to load desktop.js.
     */
    loadDesktopJs() {
        try {
            const desktopJsPath = join(this.desktopPath, 'desktop.js');
            const Desktop = require(desktopJsPath).default;
            this.desktop = new Desktop({
                log: this.loggerManager.configureLogger('desktop'),
                skeletonApp: this,
                appSettings: this.settings,
                eventsBus: this.eventsBus,
                modules: this.modules,
                Module
            });
            this.modules.desktop = this.desktop;
            this.emit('desktopLoaded', this.desktop);
            this.l.debug('desktop loaded');
        } catch (e) {
            this.l.error('could not load desktop.js', e);
        }
    }

    /**
     * Util function for emitting events on the event bus.
     * @param {string} event - event name
     * @param {[*]}    args  - event's arguments
     */
    emit(event, ...args) {
        try {
            this.eventsBus.emit(event, ...args);
        } catch (e) {
            this.l.error(`error while emitting '${event}' event: ${e}`);
        }
    }

    /**
     * Checks wheteher object seems to be a promise.
     * @param {Object} obj
     * @returns {boolean}
     */
    static isPromise(obj) {
        return !!obj && (typeof obj === 'object' || typeof obj === 'function') && typeof obj.then === 'function';
    }

    /**
     * Util function for emitting events synchronously and waiting asynchronously for
     * handlers to finish.
     * @param {string} event - event name
     * @param {[*]}    args  - event's arguments
     */
    emitAsync(event, ...args) {
        const promises = [];

        try {
            this.eventsBus.listeners(event).forEach((handler) => {
                const result = handler(...args);
                if (App.isPromise(result)) {
                    promises.push(result);
                } else {
                    promises.push(Promise.resolve());
                }
            });
        } catch (e) {
            this.l.error(`error while emitting '${event}' event: ${e}`);
            return Promise.reject(e);
        }
        return Promise.all(promises);
    }

    /**
     * Initializes this app.
     * Loads plugins.
     * Loads modules.
     * Loads desktop.js.
     * Initializes local server.
     */
    onReady() {
        this.l.info('ready fired');

        Squirrel.setUpAutoUpdater(this);

        this.emit('beforePluginsLoad');

        this.loadPlugins();

        this.emit('beforeModulesLoad');

        this.loadModules();

        this.emit('beforeDesktopJsLoad');

        // desktopLoaded event in emitted from the inside of loadDesktopJs
        this.loadDesktopJs();

        this.localServer = this.modules.localServer;

        this.localServer.setCallbacks(
            this.onStartupFailed.bind(this),
            this.onServerReady.bind(this),
            this.onServerRestarted.bind(this)
        );

        this.emit('beforeLocalServerInit');

        this.localServer.init(
            this.modules.autoupdate.getCurrentAssetBundle(),
            this.desktopPath
        );

        this.emit('afterInitialization');
    }

    /**
     * On server restart point chrome to the new port.
     * @param {number} port - port on which the app is served
     */
    onServerRestarted(port) {
        this.emitAsync('beforeLoadUrl', port, this.currentPort)
            .catch(() => {
                this.l.warning('some of beforeLoadUrl event listeners have failed');
            })
            .then(() => {
                this.currentPort = port;
                this.webContents.loadURL('meteor://desktop');
            });
    }

    /**
     * Returns prepared autoupdate module settings.
     * @returns {{dataPath: *, desktopBundlePath: String, bundleStorePath: *, initialBundlePath,
      * webAppStartupTimeout: number}}
     */
    prepareAutoupdateSettings() {
        return {
            dataPath: this.userDataDir,
            desktopBundlePath: this.userDataDir,
            bundleStorePath: this.userDataDir,
            customHCPUrl: this.settings.customHCPUrl || null,
            initialBundlePath: path.join(__dirname, '..', 'meteor.asar'),
            webAppStartupTimeout: this.settings.webAppStartupTimeout ? this.settings.webAppStartupTimeout : 20000
        };
    }

    /**
     * Handle startup failure.
     * @param {number} code - error code from local server
     */
    onStartupFailed(code) {
        this.emit('startupFailed');
        dialog.showErrorBox('Startup error', 'Could not initialize app. Please contact'
            + ` your support. Error code: ${code}`);
        this.app.quit();
    }

    /**
     * Starts the app loading in the browser.
     * @param {number} port - port on which our local server is listening
     */
    onServerReady(port) {
        const windowSettings = {
            width: 800,
            height: 600,
            webPreferences: {},
            show: false
        };

        if (process.env.METEOR_DESKTOP_SHOW_MAIN_WINDOW_ON_STARTUP) {
            windowSettings.show = true;
        }

        Object.assign(windowSettings, this.settings.window);

        // Emit windowSettings so that it can be modified if that is needed in any of the modules.
        // I do not really like, that it can modified indirectly but until 1.0 it needs to stay
        // this way.
        this.emit('windowSettings', windowSettings);

        windowSettings.webPreferences.nodeIntegration = false; // node integration must be off
        windowSettings.webPreferences.preload = join(__dirname, 'preload.js');
        windowSettings.webPreferences.enableRemoteModule = false; // disabled: deprecated since Electron 14, removed in Electron 28+; enabled renderer access to main-process Node.js APIs (XSS-to-RCE risk)

        this.currentPort = port;

        this.window = new BrowserWindow(windowSettings);
        this.window.on('closed', () => {
            this.window = null;
        });

        this.webContents = this.window.webContents;
        Module.setRenderer(this.webContents);

        if (!this.isProduction()) {
            this.webContents.on('did-finish-load', () => {
                // Print some fancy status to the console if in development.
                this.webContents.executeJavaScript(`
                console.log('%c   meteor-desktop   ',
                \`background:linear-gradient(#47848F,#DE4B4B);border:1px solid #3E0E02;
                color:#fff;display:block;text-shadow:0 3px 0 rgba(0,0,0,0.5);
                box-shadow:0 1px 0 rgba(255,255,255,0.4) inset,0 5px 3px -5px rgba(0,0,0,0.5),
                0 -13px 5px -10px rgba(255,255,255,0.4) inset;
                line-height:20px;text-align:center;font-weight:700;font-size:20px\`);
                console.log(\`%cdesktop version: ${this.settings.desktopVersion}\\n`
                    + `desktop compatibility version: ${this.settings.compatibilityVersion}\\n`
                    + 'meteor bundle version:'
                    + ` ${this.modules.autoupdate.currentAssetBundle.getVersion()}\\n\``
                    + ', \'font-size: 9px;color:#222\');');
            });
        }

        this.webContents.setWindowOpenHandler((details) => {
            const { url } = details;
            const overrideOptions = url.startsWith('meteor://') ? {
                overrideBrowserWindowOptions: {
                    webPreferences: windowSettings.webPreferences,
                    parent: this.window
                }
            } : {};
            const result = {
                action: 'allow',
                ...overrideOptions
            };
            this.emit('childWindow', result, details);
            return result;
        });

        this.emit('windowCreated', this.window);

        // Here we are catching reloads triggered by hot code push.
        this.webContents.on('will-navigate', (event, url) => {
            if (this.meteorAppVersionChange) {
                this.l.debug(`will-navigate event to ${url}, assuming that this is HCP refresh`);
                // We need to block it.
                event.preventDefault();
                this.meteorAppVersionChange = false;
                this.updateToNewVersion();
            }
        });

        // The app was loaded.
        this.webContents.on('did-stop-loading', () => {
            this.l.debug('received did-stop-loading');
            this.handleAppStartup(false);
        });

        const urlStripLength = 'meteor://desktop'.length;

        // A5: Dev/prod parity canary — track which patch types have been warned this session.
        this.a5WarnedPatches = new Set();
        const warnOnce = (key, msg) => {
            if (!this.a5WarnedPatches.has(key)) {
                this.a5WarnedPatches.add(key);
                this.l.warn(`[canary:A5] ${msg} — ensure injectEsm() applies same fix in prod build`);
            }
        };

        try {
            const meteorDevPort = this.settings.meteorDevServerPort;
            this.webContents.session.protocol.handle(
                'meteor',
                async (request) => {
                    const urlPath = request.url.substr(urlStripLength) || '/';

                    if (meteorDevPort) {
                        // Root HTML and local-only assets come from the local server,
                        // which has injectEsm() patches (type="module" script tags) applied.
                        // Serving root HTML from the dev server would skip those patches and
                        // cause "import.meta outside a module" errors in Meteor 3.x modules.js.
                        const isLocalOnly = urlPath === '/'
                            || urlPath === '/index.html'
                            || urlPath === '/cordova.js'
                            || urlPath.startsWith('/___desktop/')
                            || urlPath.startsWith('/local-filesystem/');

                        if (!isLocalOnly) {
                            // Meteor package JS files exist only in the dev server's memory
                            // (INDEX_FROM_RUNNING_SERVER mode) — fetch them from there.
                            try {
                                const devResponse = await net.fetch(
                                    `http://127.0.0.1:${meteorDevPort}/__cordova${urlPath}`
                                );
                                const ct = (devResponse.headers.get('content-type') || '').toLowerCase();
                                // Guard: Meteor's SPA catch-all returns 200+HTML for unknown paths.
                                // If we get HTML back for what should be a JS/asset request,
                                // fall through to the local server rather than surfacing HTML as JS.
                                if (devResponse.ok && !ct.includes('text/html')) {
                                    // Patch JS responses for ESM compatibility: injectEsm()
                                    // patches these at build time, but dev server files are
                                    // unpatched. In module context, 'this' at top level is
                                    // undefined, breaking 'var global = this;' patterns.
                                    if (ct.includes('javascript')) {
                                        let js = await devResponse.text();
                                        // A5: track which patch types fire so we can warn once per type.
                                        const jsOrig = js;
                                        js = js.replace(/var global = this;/g, 'var global = this || window;');
                                        js = js.replace(/global\s*=\s*this;/g, 'global = this || window;');
                                        js = js.replace(/\}\)\.call\(this\)/g, '}).call(this || window)');
                                        js = js.replace(/\}\.call\(this\)/g, '}.call(this || window)');
                                        // Polyfill import.meta: SyntaxError in classic scripts (type=module stripped).
                                        js = js.replace(/\bimport\.meta\b/g, '({url: location.href})');
                                        // IsDesktopInjector: in dev mode the bundler plugin never runs, so
                                        // packages/meteor.js still has .isCordova=!0 instead of .isDesktop=!0.
                                        // Apply the same replacements that IsDesktopInjector does at build time.
                                        js = js.replace('.isCordova=!0', '.isDesktop=!0');
                                        js = js.replace('.isCordova = true', '.isDesktop = true');
                                        // Also fix the startupDidComplete condition so it fires on isDesktop.
                                        js = js.replace(
                                            /(\(\w+\.)(?:isCordova)(\)[\S\s]*?startupDidComplete\()/gm,
                                            '$1isDesktop$2'
                                        );
                                        js = js.replace(
                                            /(\w+\.)(?:isCordova)(&&\w*\.startupDidComplete\()/gm,
                                            '$1isDesktop$2'
                                        );
                                        // A5: canary — warn (once per type) when patches were actually needed.
                                        if (js !== jsOrig) {
                                            warnOnce(
                                                'js-patches',
                                                `dev-mode JS patches applied (${urlPath}) — prod needs injectEsm`
                                            );
                                        }
                                        const headers = new Headers(devResponse.headers);
                                        headers.delete('content-length');
                                        return new Response(js, {
                                            status: devResponse.status,
                                            statusText: devResponse.statusText,
                                            headers
                                        });
                                    }
                                    return devResponse;
                                }
                            } catch (e) {
                                // Dev server unreachable, fall through to local server.
                            }
                        }
                    }

                    // Local server handles: root HTML (ESM-patched), desktop-hcp.js,
                    // desktop assets, and fallback for files absent from the dev server.
                    const localResp = await net.fetch(`http://127.0.0.1:${this.currentPort}${urlPath}`);
                    // In dev mode, strip type="module" from HTML: dev-server scripts use
                    // Meteor's IIFE/reify format with bare global assignments
                    // (meteorInstall=..., Mongo=..., Package=...) that throw ReferenceError
                    // in strict module context. Classic scripts share one global scope,
                    // allowing these assignments to succeed.
                    if (meteorDevPort) {
                        const localCt = (localResp.headers.get('content-type') || '').toLowerCase();
                        if (localCt.includes('text/html')) {
                            let html = await localResp.text();
                            const htmlOrig = html;
                            html = html.replace(/\s+type=["']module["']/gi, '');
                            // A5: canary — warn if type="module" stripping was needed in HTML.
                            if (html !== htmlOrig) {
                                warnOnce(
                                    'html-type-module',
                                    `type="module" stripped from HTML (${urlPath}) — prod needs injectEsm`
                                );
                            }
                            const localHeaders = new Headers(localResp.headers);
                            localHeaders.delete('content-length');
                            return new Response(html, {
                                status: localResp.status,
                                statusText: localResp.statusText,
                                headers: localHeaders
                            });
                        }
                    }
                    return localResp;
                }
            );
        } catch (e) {
            this.l.error(`error while registering meteor:// protocol: ${e.toString()}`);
            this.uncaughtExceptionHandler();
            return;
        }

        this.l.debug('protocol meteor:// registered');

        // A6: Boot smoke test — verify BrowserWindow loads successfully (dev mode only).
        if (!this.isProduction()) {
            this.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
                this.l.error(`[smoke:A6] BrowserWindow load FAILED: ${errorCode} ${errorDescription}`);
            });
            this.webContents.once('did-finish-load', () => {
                this.webContents.executeJavaScript('document.body ? document.body.innerHTML.length : 0')
                    .then((len) => {
                        if (len > 0) {
                            this.l.info('[smoke:A6] BrowserWindow loaded successfully (DOM has content)');
                        } else {
                            this.l.warn('[smoke:A6] BrowserWindow loaded but DOM is empty — possible white screen');
                        }
                    })
                    .catch((e) => {
                        this.l.warn(`[smoke:A6] could not verify DOM content: ${e}`);
                    });
            });
        }

        this.l.debug('opening meteor://desktop');
        setTimeout(() => {
            this.webContents.loadURL('meteor://desktop');
        }, 100);
    }

    handleAppStartup(startupDidCompleteEvent) {
        if (this.settings.showWindowOnStartupDidComplete) {
            if (!startupDidCompleteEvent) {
                return;
            }
            this.l.debug('received startupDidComplete');
        }
        this.l.info('assuming meteor webapp has loaded');
        if (this.startup) {
            console.timeEnd('startup took');
            this.startup = false;
        }
        if (!this.windowAlreadyLoaded) {
            if (this.meteorAppVersionChange) {
                this.l.verbose('there is a new version downloaded already, performing HCP reset');
                this.updateToNewVersion();
            } else {
                this.windowAlreadyLoaded = true;
                this.l.debug('showing main window');
                this.emit('beforeLoadFinish');
                this.window.show();
                this.window.focus();
            }
        } else {
            this.l.debug('window already loaded');
        }
        this.emit('loadingFinished');
    }

    /**
     * Updates to the new version received from hot code push.
     */
    updateToNewVersion() {
        this.l.verbose('entering update to new HCP version procedure');

        this.l.verbose(`${this.settings.desktopVersion} !== ${this.pendingDesktopVersion}`);

        const desktopUpdate = this.settings.desktopHCP && this.settings.desktopVersion !== this.pendingDesktopVersion;

        this.emit(
            'beforeReload', this.modules.autoupdate.getPendingVersion(), desktopUpdate
        );

        if (desktopUpdate) {
            this.l.info('relaunching to use different version of desktop.asar');
            // Give winston a chance to write the logs.
            setImmediate(() => {
                app.relaunch({ args: process.argv.slice(1).concat('--hcp') });
                app.quit();
            });
        } else {
            // Firing reset routine.
            this.l.debug('firing onReset from autoupdate');
            this.modules.autoupdate.onReset();

            // Reinitialize the local server.
            this.l.debug('resetting local server');
            this.localServer.init(
                this.modules.autoupdate.getCurrentAssetBundle(),
                this.desktopPath,
                true
            );
        }
    }
}

if (!process.env.METEOR_DESKTOP_UNIT_TEST) {
    const appInstance = new App(); // eslint-disable-line no-unused-vars
}
