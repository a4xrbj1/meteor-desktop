import { join } from 'path';
import fs from 'fs';

/**
 * The skeleton's main-process logger.
 *
 * WHY THERE IS NO LOGGING LIBRARY HERE (seed meteor-desktop-f570).
 * This used to be a thin wrapper over winston 3.13.0 — 1.4 MB and 11 transitive dependencies —
 * installed into every consumer's `.meteor/desktop-build/` for a surface of five level methods, one
 * console sink and one size-rotated file. Worse, the wrapper had been written against winston 2 and
 * was never migrated, so several of its options had silently stopped doing anything:
 *
 *   - `logger.filters.push(...)`, which was supposed to prefix every line with `[entityName]`.
 *     Winston 3 removed `filters` outright. Measured on a real 4.1 MB run.log: ZERO lines carried
 *     the prefix. Nothing had used it for as long as that file has existed.
 *   - `json: false` and `colorize`, both winston 2 transport options. Winston 3 takes a `format`,
 *     so run.log was JSON no matter what this file asked for.
 *   - Extra arguments. `this.l.info('app data dir is:', this.userDataDir)` (app.js:71) needs
 *     `format.splat()` on winston 3; without it the second argument is DROPPED. The first line of
 *     that same run.log is `{"level":"info","message":"app data dir is:"}` — the path is simply
 *     gone. Five call sites in the skeleton log this way, including `l.error('...', err)`.
 *   - Error objects. `this.l.error(e)` (app.js:239) produced a message with no stack; that 4.1 MB
 *     file contains not one `stack` key.
 *
 * So the dependency was paying for behaviour we were not getting. This implementation is the
 * behaviour that was actually intended, in code small enough to read in one sitting, and it fixes
 * all four losses above.
 *
 * WHAT IS DELIBERATELY UNCHANGED, because things outside this repo depend on it:
 *   - The record is ONE LINE of JSON with `"level"` first and `"message"` second, and the message
 *     text still starts immediately after `"message":"`. A consumer app's telemetry reporter greps
 *     run.log with a regex anchored on exactly that (`frontend/.desktop/telemetry.js` RUN_LOG_NOISE
 *     matches `"message":"(saving \/|making bundle object|...)`) to drop hot-code-push churn before
 *     uploading. Prefixing the message — the very thing the dead `filters` line tried to do — would
 *     silently break that filter and flood every uploaded crash report with asset noise. The entity
 *     goes in its own trailing field instead, where it is visible and harmless. `time` was added
 *     later (seed meteor-desktop-1a97) and is trailing for exactly the same reason.
 *   - `userDataDir/run.log` at 5 MB with 5 archives, and one `<entityName>.log` per module/plugin.
 *   - `getMainLogger()`, `configureLogger(name)` and `logger.getLoggerFor(sub)`.
 *
 * AND WHAT IS GONE ON PURPOSE: the old `try { require('winston') } catch` fallback, which replaced
 * every log method with `Function.prototype`. A missing logger meant run.log silently stopped being
 * written, with no error anywhere — and the stub did not even define `verbose`, which the skeleton
 * calls 20 times, so it would have thrown rather than no-opped. There is nothing to fall back to
 * now; if a sink cannot be opened it says so on the console and the process keeps running.
 */

// Matches the old winston File transport configuration, which is what produced the run.log /
// run1.log ... run5.log set every consumer already has on disk.
const MAX_FILE_SIZE = 5242880;
const MAX_ARCHIVES = 5;
// How many write attempts to skip after a sink failure before trying to reopen. Bounds the
// syscall cost of a genuinely broken path without silencing the sink permanently.
const RETRY_AFTER_WRITES = 100;
// The levels the skeleton actually calls, measured across skeleton/: debug 32, error 25, info 23,
// verbose 20, warn 16. `log` is kept as an alias for `info` because the old fallback shape exposed
// it. The old config's `level: 'debug'` admitted every one of these, so it filtered nothing and is
// not reproduced — there is no level below debug in use anywhere.
const LEVELS = ['error', 'warn', 'info', 'verbose', 'debug'];

/**
 * Renders one logged argument.
 *
 * Errors keep their stack, which winston was dropping. The stack's newlines are safe because the
 * caller serialises the whole record with JSON.stringify, which escapes them — so a stack trace
 * stays on ONE physical line and the file remains one record per line.
 *
 * @param {*} value - Anything passed to a log method.
 *
 * @returns {String} Its printable form.
 */
const renderArgument = function renderArgument(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value instanceof Error) {
        return value.stack || `${value.name}: ${value.message}`;
    }
    if (value === null || value === undefined || typeof value !== 'object') {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        // Circular or otherwise unserialisable - never let logging throw.
        return String(value);
    }
};

/**
 * An append-only log file that rotates when it grows past `maxSize`.
 *
 * Holds one file descriptor open and uses `fs.writeSync`, rather than reopening per line or
 * buffering. Reopening per line would be a syscall storm during a hot-code-push download, which is
 * ~40% of run.log's volume; buffering would lose exactly the lines that matter, because the reason
 * this file exists is to explain a crash or a hang.
 */
export class RotatingFile {
    /**
     * @param {String} filePath - Absolute path of the live file.
     * @param {Number} maxSize - Bytes after which the file rotates.
     * @param {Number} maxArchives - How many numbered archives to keep.
     */
    constructor(filePath, maxSize = MAX_FILE_SIZE, maxArchives = MAX_ARCHIVES) {
        this.filePath = filePath;
        this.maxSize = maxSize;
        this.maxArchives = maxArchives;
        this.fd = null;
        this.size = 0;
        // A failure must not silence this sink for the rest of the session - that is the silent-loss
        // behaviour this whole rewrite exists to remove. Instead we back off for RETRY_AFTER_WRITES
        // and try again, and we report the problem exactly once so a full disk cannot spam the
        // console on every line.
        this.retryIn = 0;
        this.reported = false;
    }

    /**
     * Records a sink failure: reports it once, drops the descriptor and backs off.
     *
     * @param {String} what - What was being attempted, for the console line.
     * @param {Error} error - The failure.
     */
    fail(what, error) {
        try {
            if (this.fd !== null) {
                fs.closeSync(this.fd);
            }
        } catch {
            // The descriptor is already gone; nothing to salvage.
        }
        this.fd = null;
        this.retryIn = RETRY_AFTER_WRITES;
        if (!this.reported) {
            this.reported = true;
            // Deliberately loud, and deliberately not a throw: losing the log must never take the
            // app down, but it must never be silent either - that was the old fallback's whole bug.
            console.error(`[meteor-desktop] log sink ${this.filePath} ${what}: ${error && error.message}`);
        }
    }

    /**
     * Opens the file for appending, remembering its current size.
     *
     * @returns {Boolean} True when the sink is usable.
     */
    open() {
        if (this.fd !== null) {
            return true;
        }
        if (this.retryIn > 0) {
            this.retryIn -= 1;
            return false;
        }
        try {
            try {
                this.size = fs.statSync(this.filePath).size;
            } catch {
                this.size = 0;
            }
            this.fd = fs.openSync(this.filePath, 'a');
            return true;
        } catch (error) {
            this.fail('unavailable', error);
            return false;
        }
    }

    /**
     * Shifts `<name>N.log` down one slot and starts a fresh live file.
     *
     * Numbered lowest-is-newest, matching the run1.log ... run5.log set winston already produced,
     * so an existing installation's files keep meaning the same thing.
     */
    rotate() {
        const dotIndex = this.filePath.lastIndexOf('.');
        const stem = dotIndex === -1 ? this.filePath : this.filePath.slice(0, dotIndex);
        const extension = dotIndex === -1 ? '' : this.filePath.slice(dotIndex);
        try {
            if (this.fd !== null) {
                fs.closeSync(this.fd);
                this.fd = null;
            }
            for (let index = this.maxArchives; index >= 1; index -= 1) {
                const target = `${stem}${index}${extension}`;
                const source = index === 1 ? this.filePath : `${stem}${index - 1}${extension}`;
                if (index === this.maxArchives) {
                    try {
                        fs.unlinkSync(target);
                    } catch {
                        // Nothing to drop on the first few rotations.
                    }
                }
                try {
                    fs.renameSync(source, target);
                } catch {
                    // That archive slot is not populated yet.
                }
            }
            this.size = 0;
        } catch (error) {
            this.fail('could not rotate', error);
        }
    }

    /**
     * Appends one already-serialised record.
     *
     * @param {String} line - The record, without a trailing newline.
     */
    write(line) {
        if (!this.open()) {
            return;
        }
        const payload = `${line}\n`;
        const bytes = Buffer.byteLength(payload);
        if (this.size + bytes > this.maxSize) {
            this.rotate();
            if (!this.open()) {
                return;
            }
        }
        try {
            fs.writeSync(this.fd, payload);
            this.size += bytes;
        } catch (error) {
            // Transient on Windows, where an antivirus or indexer can hold the file briefly. The
            // descriptor is dropped and reopened after the backoff rather than giving up for the
            // session, so a momentary lock costs a few lines instead of every later line.
            this.fail('write failed', error);
        }
    }
}

export default class LoggerManager {
    /**
     * @param {App} $ - context.
     */
    constructor($) {
        this.$ = $;
        // Shared by every logger, exactly as winston.loggers.options.transports was.
        this.runLog = new RotatingFile(join($.userDataDir, 'run.log'));
        /** @type {Object<String, Object>} */
        this.loggers = {};
        this.mainLogger = this.configureLogger();
    }

    /**
     * @returns {Log}
     */
    getMainLogger() {
        return this.mainLogger;
    }

    /**
     * Returns a logger for one entity, creating it on first use.
     *
     * Anything other than `main` also gets its own `<entityName>.log` beside run.log, which is what
     * produces the per-module and per-plugin files (autoupdate.log, localServer.log, desktop.log,
     * meteor-desktop-splash-screen.log ...). Sub-loggers from `getLoggerFor` write to run.log only,
     * which is also how the winston registry behaved.
     *
     * @param {string} entityName
     * @returns {Log}
     */
    configureLogger(entityName = 'main') {
        if (this.loggers[entityName]) {
            return this.loggers[entityName];
        }
        const sinks = [this.runLog];
        if (entityName !== 'main') {
            sinks.push(new RotatingFile(join(this.$.userDataDir, `${entityName}.log`)));
        }
        const logger = this.createLogger(entityName, sinks);
        this.loggers[entityName] = logger;
        return logger;
    }

    /**
     * Builds the logger object handed to the skeleton, its modules and every plugin.
     *
     * @param {String} entityName - Identifies the writer; emitted as the record's `entity` field.
     * @param {Array<RotatingFile>} sinks - Files this logger writes to.
     *
     * @returns {Object} A logger exposing error/warn/info/verbose/debug/log and getLoggerFor.
     */
    createLogger(entityName, sinks) {
        const logger = { entityName };
        LEVELS.forEach((level) => {
            logger[level] = function writeRecord(...args) {
                const message = args.map(renderArgument).join(' ');
                // Key order matters: consumers grep run.log for `"message":"<text>` (see the header),
                // so `time` goes at the END, for the same reason `entity` does. ISO-8601 rather than
                // epoch millis because a partly-upgraded install has BOTH the old plain-text winston
                // lines and these JSON ones in one run.log, and a human scanning it should see a
                // date in both halves rather than an opaque integer in one. The two formats are
                // otherwise nothing alike (seed meteor-desktop-1a97).
                const line = JSON.stringify({
                    level, message, entity: entityName, time: new Date().toISOString()
                });
                sinks.forEach((sink) => sink.write(line));
                const target = (level === 'error' || level === 'warn') ? console.error : console.log;
                target(`[${entityName}] ${message}`);
            };
        });
        logger.log = logger.info;
        logger.getLoggerFor = (subEntityName) => this.configureSubLogger(entityName, subEntityName);
        return logger;
    }

    /**
     * Returns the `entity/sub` logger, creating it once.
     *
     * @param {String} entityName - Parent entity.
     * @param {String} subEntityName - Sub-entity, e.g. a plugin's individual component.
     *
     * @returns {Object} The sub-logger, writing to run.log only.
     */
    configureSubLogger(entityName, subEntityName) {
        const key = `${entityName}/${subEntityName}`;
        if (!this.loggers[key]) {
            this.loggers[key] = this.createLogger(key, [this.runLog]);
        }
        return this.loggers[key];
    }
}
