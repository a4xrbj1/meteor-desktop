import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const createFallbackLogger = function createFallbackLogger() {
    return {
        filters: [],
        add: Function.prototype,
        debug: Function.prototype,
        error: Function.prototype,
        info: Function.prototype,
        warn: Function.prototype,
        log: Function.prototype
    };
};

let winston;
try {
    winston = require('winston');
} catch (e) {
    const registry = {};
    winston = {
        transports: {
            Console: class Console {},
            File: class File {}
        },
        loggers: {
            options: { transports: [] },
            loggers: registry,
            add(name) {
                if (!registry[name]) {
                    registry[name] = createFallbackLogger();
                }
            },
            get(name) {
                if (!registry[name]) {
                    registry[name] = createFallbackLogger();
                }
                return registry[name];
            }
        }
    };
}

export default class LoggerManager {
    /**
     * @param {App} $ - context.
     */
    constructor($) {
        this.$ = $;

        /* TODO: fix `Possible EventEmitter memory leak detected.` warning - will probably have to
                 drop winston in favor of bunyan (winston does not seem to be actively supported)
        */

        // Default Winston transports.
        this.fileLogConfiguration = {
            level: 'debug',
            filename: join($.userDataDir, 'run.log'),
            handleExceptions: false,
            json: false,
            maxsize: 5242880, // 5MB
            maxFiles: 5,
            colorize: false
        };
        this.consoleLogConfiguration = {
            level: 'debug',
            handleExceptions: false,
            json: false,
            colorize: true
        };

        this.loggerTransports = [
            new (winston.transports.Console)(this.consoleLogConfiguration),
            new (winston.transports.File)(this.fileLogConfiguration)
        ];

        winston.loggers.options.transports = this.loggerTransports;
        this.mainLogger = this.configureLogger();
    }

    /**
     * @returns {Log}
     */
    getMainLogger() {
        return this.mainLogger;
    }

    /**
     * Returns a new logger instance.
     * @param {string} entityName
     * @returns {Log}
     */
    configureLogger(entityName = 'main') {
        winston.loggers.add(entityName, {});

        const logger = winston.loggers.get(entityName);
        if (entityName !== 'main') {
            logger.add(new (winston.transports.File)({
                level: 'debug',
                name: entityName,
                handleExceptions: false,
                filename: join(this.$.userDataDir, `${entityName}.log`)
            }));
        }

        if (!Array.isArray(logger.filters)) {
            logger.filters = [];
        }

        logger.filters.push((level, msg) => `[${entityName}] ${msg}`);
        logger.entityName = entityName;

        logger.getLoggerFor = (subEntityName) => {
            if (!winston.loggers.loggers[`${logger.entityName}__${subEntityName}`]) {
                winston.loggers.add(`${logger.entityName}__${subEntityName}`, {});
                const newLogger = winston.loggers.get(`${logger.entityName}__${subEntityName}`);

                if (!Array.isArray(newLogger.filters)) {
                    newLogger.filters = [];
                }

                newLogger.filters.push((level, msg) => `[${logger.entityName}] [${subEntityName}] ${msg}`);
                newLogger.getLoggerFor = logger.getLoggerFor;
                return newLogger;
            }
            return winston.loggers.get(`${logger.entityName}__${subEntityName}`);
        };

        return logger;
    }
}
