import fs from 'fs';
import os from 'os';
import path from 'path';
import * as chai from 'chai';
import dirty from 'dirty-chai';

import LoggerManager, { RotatingFile } from '../../../skeleton/loggerManager.js';

chai.use(dirty);
const {
    describe,
    it,
    beforeEach,
    afterEach
} = global;
const { expect } = chai;

// The exact regex a consumer app greps run.log with before uploading a crash report
// (frontend/.desktop/telemetry.js RUN_LOG_NOISE). It anchors on `"message":"` immediately followed
// by the message text, so it is the contract that forbids prefixing the message itself. Copied
// verbatim rather than imported: it lives in another repo, and the point is to fail HERE if this
// logger's record shape drifts away from what that regex needs.
const RUN_LOG_NOISE = new RegExp('"message":"(saving \\/|making bundle object|created download dir'
    + '|manifest copied|manifest has |downloader created|loading manifest from|checking for updates'
    + '|trying to query|downloaded asset manifest|skipping downloading|[0-9]+ entries\\. \\(Version)');

let userDataDir;
let loggerManager;
let consoleLog;
let consoleError;

/**
 * Reads one log file from the temp userData dir as an array of records.
 *
 * @param {String} name - File name, e.g. 'run.log'.
 * @returns {Array<Object>} Parsed records.
 */
const records = (name) => fs.readFileSync(path.join(userDataDir, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

/**
 * Reads one log file as raw text.
 *
 * @param {String} name - File name.
 * @returns {String} File contents.
 */
const raw = (name) => fs.readFileSync(path.join(userDataDir, name), 'utf8');

describe('LoggerManager', () => {
    beforeEach(() => {
        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-loggermanager-'));
        // This logger writes to the console on every call by design (the winston Console transport
        // did too). Silencing it keeps the mocha reporter readable.
        consoleLog = console.log;
        consoleError = console.error;
        console.log = () => {};
        console.error = () => {};
        loggerManager = new LoggerManager({ userDataDir });
    });

    afterEach(() => {
        console.log = consoleLog;
        console.error = consoleError;
        fs.rmSync(userDataDir, { recursive: true, force: true });
    });

    describe('the record shape other repos depend on', () => {
        it('writes one JSON record per line with level first and message second', () => {
            loggerManager.getMainLogger().info('hello');
            const line = raw('run.log').trim();
            expect(line.split('\n')).to.have.lengthOf(1);
            // Key ORDER is the contract, not merely key presence: the consumer regex below anchors
            // on `"message":"` immediately following the level, so a reordering that still parsed
            // to the same object would break it. Asserted explicitly rather than implied by the
            // string match, so a future field lands in the right place.
            expect(Object.keys(JSON.parse(line))).to.deep.equal(['level', 'message', 'entity', 'time']);
            expect(line).to.match(
                /^\{"level":"info","message":"hello","entity":"main","time":"[^"]+"\}$/
            );
        });

        // run.log is the file a consumer's telemetry uploads on a crash or a stuck startup, and it
        // is the shell's only record of the window lifecycle and the startup timer. Without this
        // field no duration question can be answered from it at all - which is what happened to
        // frontend-0144 item (a), "why did the renderer need more than 60 seconds", on a real
        // end-user report (seed meteor-desktop-1a97).
        it('timestamps every record in ISO-8601, so a report can answer a duration question', () => {
            const before = Date.now();
            loggerManager.getMainLogger().info('first');
            loggerManager.configureLogger('autoupdate').warn('second');
            const after = Date.now();
            const all = [...records('run.log'), ...records('autoupdate.log')];
            expect(all).to.have.lengthOf(3);
            all.forEach((record) => {
                expect(record.time, JSON.stringify(record)).to.be.a('string');
                // Round-tripping through Date proves it is parseable AND canonical - a non-ISO
                // string would either fail to parse or re-serialise differently.
                expect(new Date(record.time).toISOString()).to.equal(record.time);
                const at = Date.parse(record.time);
                expect(at).to.be.at.least(before);
                expect(at).to.be.at.most(after);
            });
        });

        it('leaves the consumer telemetry noise filter matching', () => {
            // Prefixing the message - which the old dead `filters` line tried to do - would break
            // this, silently flooding every uploaded crash report with hot-code-push churn.
            const log = loggerManager.configureLogger('autoupdate');
            log.debug('saving /app/some-asset.js');
            log.info('checking for updates');
            raw('run.log').trim().split('\n').forEach((line) => {
                expect(RUN_LOG_NOISE.test(line), line).to.be.true();
            });
        });

        it('carries the entity in its own field rather than in the message', () => {
            loggerManager.configureLogger('localServer').warn('port taken');
            const record = records('run.log').find((r) => r.message === 'port taken');
            expect(record.entity).to.equal('localServer');
            expect(record.message).to.equal('port taken');
        });
    });

    describe('what winston was silently losing', () => {
        it('keeps every argument, not just the first', () => {
            // skeleton/app.js:71 logs `('app data dir is:', this.userDataDir)`. Winston 3 without
            // format.splat() dropped the second argument; a real 4.1MB run.log's first line is
            // `{"level":"info","message":"app data dir is:"}` with the path simply gone.
            loggerManager.getMainLogger().info('app data dir is:', '/tmp/x', 42);
            expect(records('run.log')[0].message).to.equal('app data dir is: /tmp/x 42');
        });

        it('keeps an Error\'s stack, on a single line', () => {
            loggerManager.getMainLogger().error(new Error('boom'));
            const lines = raw('run.log').trim().split('\n');
            expect(lines).to.have.lengthOf(1);
            expect(JSON.parse(lines[0]).message).to.contain('Error: boom');
            expect(JSON.parse(lines[0]).message).to.contain('\n    at ');
        });

        it('supports verbose, which the old fallback stub omitted despite 20 call sites', () => {
            loggerManager.getMainLogger().verbose('tracing');
            expect(records('run.log')[0].level).to.equal('verbose');
        });

        it('never throws on an unserialisable argument', () => {
            const circular = {};
            circular.self = circular;
            expect(() => loggerManager.getMainLogger().debug(circular)).to.not.throw();
        });
    });

    describe('file layout', () => {
        it('gives every non-main entity its own file as well as run.log', () => {
            loggerManager.configureLogger('autoupdate').info('checking for updates');
            expect(fs.existsSync(path.join(userDataDir, 'autoupdate.log'))).to.be.true();
            expect(records('autoupdate.log')).to.have.lengthOf(1);
            expect(records('run.log')).to.have.lengthOf(1);
        });

        it('keeps one entity out of another entity\'s file', () => {
            loggerManager.configureLogger('autoupdate').info('a');
            loggerManager.configureLogger('localServer').info('b');
            expect(records('autoupdate.log').every((r) => r.entity === 'autoupdate')).to.be.true();
        });

        it('routes sub-loggers to run.log only, and names them entity/sub', () => {
            const sub = loggerManager.configureLogger('meteor-desktop-splash-screen').getLoggerFor('splashWindow');
            sub.verbose('enabling click through');
            expect(records('run.log').pop().entity).to.equal('meteor-desktop-splash-screen/splashWindow');
            expect(fs.existsSync(path.join(userDataDir, 'splashWindow.log'))).to.be.false();
        });

        it('returns the same instance for a repeated entity or sub-entity', () => {
            expect(loggerManager.configureLogger('autoupdate')).to.equal(loggerManager.configureLogger('autoupdate'));
            const parent = loggerManager.configureLogger('desktop');
            expect(parent.getLoggerFor('a')).to.equal(parent.getLoggerFor('a'));
        });
    });

    describe('rotation', () => {
        // Driven through RotatingFile with a tiny cap rather than by pushing 26 MB through the
        // 5 MB run.log: the archive cap only binds on the FIFTH rotation, so a size-driven test
        // through the real logger would never reach the unlink-oldest branch it claims to cover.
        /**
         * Fills a sink until it has rotated several times over.
         *
         * @param {RotatingFile} sink - The sink under test.
         * @param {Number} count - How many records to write.
         */
        const fill = (sink, count) => {
            for (let i = 0; i < count; i += 1) {
                sink.write(`line-${i}-${'y'.repeat(40)}`);
            }
        };

        it('bounds the archive set and unlinks the oldest', () => {
            fill(new RotatingFile(path.join(userDataDir, 'run.log'), 200, 5), 200);
            const set = fs.readdirSync(userDataDir).filter((f) => /^run\d*\.log$/.test(f));
            expect(set.sort()).to.deep.equal(['run.log', 'run1.log', 'run2.log', 'run3.log', 'run4.log', 'run5.log']);
            expect(fs.existsSync(path.join(userDataDir, 'run6.log'))).to.be.false();
        });

        it('keeps the live file newest and run1 newer than run5', () => {
            fill(new RotatingFile(path.join(userDataDir, 'run.log'), 200, 5), 200);
            const newest = (name) => Number(raw(name).match(/line-(\d+)/g).pop().split('-')[1]);
            expect(raw('run.log')).to.contain('line-199');
            expect(newest('run1.log')).to.be.above(newest('run5.log'));
        });

        it('loses no record inside the retained window', () => {
            fill(new RotatingFile(path.join(userDataDir, 'run.log'), 200, 5), 200);
            const numbers = ['run5.log', 'run4.log', 'run3.log', 'run2.log', 'run1.log', 'run.log']
                .flatMap((name) => raw(name).trim().split('\n'))
                .filter(Boolean)
                .map((line) => Number(line.match(/line-(\d+)/)[1]))
                .sort((a, b) => a - b);
            expect(numbers[numbers.length - 1]).to.equal(199);
            expect(numbers.every((value, index) => index === 0 || value === numbers[index - 1] + 1)).to.be.true();
        });
    });

    describe('failure is loud, never silent', () => {
        it('reports an unusable sink on the console instead of no-opping', () => {
            // The whole bug in the old `try { require('winston') } catch` fallback: it replaced
            // every method with Function.prototype, so run.log just stopped being written.
            const messages = [];
            console.error = (message) => messages.push(message);
            const broken = new LoggerManager({ userDataDir: path.join(userDataDir, 'does', 'not', 'exist') });
            broken.getMainLogger().error('still runs');
            expect(messages.join('\n')).to.contain('log sink');
            expect(messages.join('\n')).to.contain('unavailable');
        });

        it('keeps the app running when the log cannot be written', () => {
            const broken = new LoggerManager({ userDataDir: path.join(userDataDir, 'nope') });
            expect(() => broken.getMainLogger().info('x')).to.not.throw();
        });

        it('recovers after a transient write failure instead of going quiet for the session', () => {
            // A REAL failure, provoked without stubbing anything: closing the descriptor behind the
            // sink's back makes the next writeSync return a genuine EBADF from the OS, so the
            // production catch branch runs for real. The old winston fallback's equivalent state
            // was permanent - that is the bug this rewrite exists to remove, so it is asserted.
            const messages = [];
            console.error = (message) => messages.push(String(message));
            const sink = new RotatingFile(path.join(userDataDir, 'flaky.log'));
            sink.write('before');
            fs.closeSync(sink.fd);
            sink.write('lost to EBADF');
            expect(messages.filter((m) => m.includes('flaky.log'))).to.have.lengthOf(1);
            expect(messages.join('\n')).to.contain('EBADF');
            expect(sink.retryIn).to.be.above(0);
            sink.retryIn = 0;
            sink.write('after-recovery');
            const text = fs.readFileSync(path.join(userDataDir, 'flaky.log'), 'utf8');
            expect(text).to.contain('before');
            expect(text).to.contain('after-recovery');
        });

        it('reports a failing sink only once, however many lines follow', () => {
            const messages = [];
            console.error = (message) => messages.push(String(message));
            const sink = new RotatingFile(path.join(userDataDir, 'noisy.log'));
            sink.write('open it');
            fs.closeSync(sink.fd);
            for (let i = 0; i < 50; i += 1) {
                sink.write(`line ${i}`);
            }
            expect(messages.filter((m) => m.includes('noisy.log'))).to.have.lengthOf(1);
        });
    });
});
