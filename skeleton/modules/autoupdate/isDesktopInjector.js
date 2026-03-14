/**
 * Until we would have a `web.desktop` arch in Meteor we need to provide a way to distinguish
 * the desktop specific code. The easiest approach is to have a Meteor.isDesktop. Since we do not
 * want the `Meteor.isCordova` to be true we just replace it with `isDesktop`.
 * Also we need to change the faulty version check procedure to fire on desktop architecture.
 */

class IsDesktopInjector {
    constructor() {
        this.startupDidCompleteRegEx = new RegExp('\\.isCordova\\)[\\S\\s]*?startupDidComplete\\(', 'gm');

        this.startupDidCompleteRegExReplace = new RegExp('(\\(\\w+\\.)(?:isCordova)(\\)[\\S\\s]*?startupDidComplete\\()', 'gm');

        this.startupDidCompleteProductionRegEx = new RegExp('\\.isCordova&&\\w*\\.startupDidComplete', 'gm');

        this.startupDidCompleteProductionRegExReplace = new RegExp('(\\w+\\.)(?:isCordova)(&&\\w*\\.startupDidComplete\\()', 'gm');
    }

    /**
     * Searches for and replaces two places in Meteor app:
     *  - where `isCordova` is declared (web.browser object-literal form)
     *  - where `startupDidComplete` is fired
     *
     * @param {string} contents
     * @returns {{fileContents: *, injectedStartupDidComplete: boolean, injected: boolean}}
     */
    processFileContents(contents) {
        // This searches for the place where `startupDidComplete` is fired. We need that now to be
        // fired when `isDesktop` is set.

        let injectedStartupDidComplete = false;
        let injected = false;
        let fileContents = contents;

        // This changes the place where `isCordova` is declared.
        // Web.browser patterns (Meteor 3.x object-literal form: isCordova: false).
        // Inject isDesktop: true alongside the falsy isCordova declaration so that
        // Meteor.isDesktop becomes true even though isCordova is false.
        fileContents = fileContents.replace('isCordova: false,', 'isCordova: false, isDesktop: true,');
        // Minified variants (terser outputs !1 for false, !0 for true):
        fileContents = fileContents.replace('isCordova:!1,', 'isCordova:!1,isDesktop:!0,');
        fileContents = fileContents.replace('isCordova:false,', 'isCordova:false,isDesktop:!0,');

        if (this.startupDidCompleteRegEx.test(fileContents)) {
            fileContents = fileContents.replace(
                this.startupDidCompleteRegExReplace,
                '$1isDesktop$2'
            );
            injectedStartupDidComplete = true;
        }
        if (this.startupDidCompleteProductionRegEx.test(fileContents)) {
            fileContents = fileContents.replace(
                this.startupDidCompleteProductionRegExReplace,
                '$1isDesktop$2'
            );
            injectedStartupDidComplete = true;
        }

        if (~fileContents.indexOf('isDesktop: true,')
            || ~fileContents.indexOf('isDesktop:!0,')) {
            injected = true;
        }

        this.startupDidCompleteProductionRegEx.lastIndex = 0;
        this.startupDidCompleteRegEx.lastIndex = 0;
        this.startupDidCompleteProductionRegExReplace.lastIndex = 0;
        this.startupDidCompleteRegExReplace.lastIndex = 0;

        return {
            fileContents,
            injectedStartupDidComplete,
            injected
        };
    }
}

export default IsDesktopInjector;
