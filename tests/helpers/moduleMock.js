import Module from 'module';

/**
 * Minimal stand-in for the `mockery` package, which is unmaintained and carries a critical
 * prototype-pollution advisory (GHSA-gmwp-3pwc-3j3g, CVSS 9.8) whose range is `*` — there is no
 * fixed version to upgrade to.
 *
 * It reimplements only the five calls this suite actually uses, and it does so with mockery's own
 * mechanism rather than a different one: a hook on `Module._load` that returns a registered mock
 * for a matching request and otherwise delegates to the real loader. Keeping the mechanism
 * identical is the point — it intercepts exactly what mockery intercepted, no more and no less, so
 * no test changes meaning.
 *
 * What that covers, precisely. A `Module._load` hook sees CJS `require()` and nothing else, so
 * every specifier this suite registers is reached through a `createRequire()` call, some at module
 * top level during load, some long after loading finished:
 *   - `electron`     — `skeleton/app.js:25`, at top level during load, which is why `app.test.js`
 *                      must `enable()` before it requires the module; and `skeleton/preload.js:18`
 *                      plus `:356`, the latter inside a `process.once('loaded')` callback
 *   - `original-fs`  — `skeleton/modules/autoupdate.js:48`
 *
 * A specifier the skeleton reaches through ESM `import` cannot be mocked here at all: it resolves
 * through the ESM loader, which no `Module._load` hook can observe. `app.test.js` used to register
 * `fs-plus` and `./desktopPathResolver` (`skeleton/app.js:4` and `:7`, both ESM imports); both were
 * inert under mockery for the same reason and have since been deleted (seed meteor-desktop-7683).
 * Verified by loading a probe module that imports both specifiers while a mock for each was
 * registered: the CJS `require()` returned the mock, both ESM bindings returned the real module.
 *
 * `proxyquire` is not a substitute either — its stubs apply only for the duration of the load call
 * and only to a module's direct dependencies, so it cannot cover those lazy post-load `require()`
 * calls. It was removed as an unused devDependency in the same seed.
 *
 * mockery's `warnOnReplace` / `warnOnUnregistered` options are not reimplemented because the suite
 * set both to `false`, making the warning branches dead. `useCleanCache` was never enabled either,
 * so there is no module-registry juggling to mirror.
 */

/** @type {Object<String, *>} */
let registeredMocks = {};
/** @type {any} */
const NodeModule = Module; // _load is a Node internal absent from @types/node — same idiom as skeleton/app.js:97
/** @type {Function|null} */
let originalLoader = null;

/**
 * Replacement for `Module._load` that serves registered mocks and delegates everything else.
 * Only ever installed by `enable`, which captures `originalLoader` first, so that value is
 * non-null for the whole time this function is reachable.
 *
 * @param {String} request - The module specifier passed to `require()`.
 * @param {...*} rest      - The remaining loader arguments (`parent`, `isMain`), passed through.
 *
 * @returns {*} - The registered mock, or whatever the real loader returns.
 */
const hookedLoader = function (request, ...rest) {
    if (Object.hasOwn(registeredMocks, request)) {
        return registeredMocks[request];
    }
    return originalLoader.call(this, request, ...rest);
};

/**
 * Registers a mock to be returned for `require(request)`. May be called before or after `enable`.
 *
 * @param {String} request - The module specifier to intercept.
 * @param {*} mock         - The value `require()` should return for it.
 *
 * @returns {void}
 */
const registerMock = function (request, mock) {
    registeredMocks[request] = mock;
};

/**
 * Removes a single registered mock. Unknown specifiers are ignored, as in mockery.
 *
 * @param {String} request - The module specifier to stop intercepting.
 *
 * @returns {void}
 */
const deregisterMock = function (request) {
    delete registeredMocks[request];
};

/**
 * Removes every registered mock.
 *
 * @returns {void}
 */
const deregisterAll = function () {
    registeredMocks = {};
};

/**
 * Hooks the module loader. Idempotent, matching mockery — a second call while already hooked is a
 * no-op rather than an error, so it cannot capture its own hook as the original loader.
 *
 * @returns {void}
 */
const enable = function () {
    if (originalLoader !== null) {
        return;
    }
    originalLoader = NodeModule._load;
    NodeModule._load = hookedLoader;
};

/**
 * Restores the real module loader. Idempotent, matching mockery. Registered mocks survive a
 * disable, so an `enable` / `disable` pair can bracket part of a test without re-registering.
 *
 * @returns {void}
 */
const disable = function () {
    if (originalLoader === null) {
        return;
    }
    NodeModule._load = originalLoader;
    originalLoader = null;
};

export default {
    registerMock, deregisterMock, deregisterAll, enable, disable
};
