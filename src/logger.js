import winston from 'winston';
import fs from 'fs';

if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
            return `[${timestamp}] ${level.toUpperCase()}: ${message} ${metaStr}`.trim();
        })
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
                    return `[${timestamp}] ${level}: ${message} ${metaStr}`.trim();
                })
            )
        }),
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
            maxsize: 5242880,
            maxFiles: 3,
        }),
        new winston.transports.File({
            filename: 'logs/combined.log',
            format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
            maxsize: 10485760,
            maxFiles: 3,
        }),
    ],
});

// ✅ Add missing methods for Baileys compatibility
logger.trace = logger.silly;   // map trace → silly
logger.debug = logger.debug || ((msg) => logger.log('debug', msg));

export default logger;
