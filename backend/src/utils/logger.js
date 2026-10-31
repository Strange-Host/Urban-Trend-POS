const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Same directory family as the backups folder — both are operational data
// that lives next to the database, not application code.
const LOG_DIR = path.join(path.dirname(process.env.DATABASE_PATH || './data/urban_trends.db'), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const isProduction = process.env.NODE_ENV === 'production';

// Size-based rotation, built into winston's File transport (no extra package). When a file reaches maxsize it is
// renamed to app1.log (older ones shift to app2.log ...) and a fresh app.log starts; once maxFiles files exist the
// oldest is deleted. With the defaults each log is capped at about LOG_MAX_MB x LOG_MAX_FILES = 50 MB, so logs can
// no longer fill the volume the database lives on. tailable keeps the newest entries in app.log itself.
const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
const ROTATION = {
  maxsize: positive(process.env.LOG_MAX_MB, 10) * 1024 * 1024,
  maxFiles: Math.floor(positive(process.env.LOG_MAX_FILES, 5)),
  tailable: true,
};

// Console: human-readable in development, structured JSON in production
// (so it's grep/parse-friendly if piped into a log aggregator later).
// File: always JSON, always on — this is what makes "what happened at
// 3am when the sync job failed" answerable without having had a terminal
// open at the time.
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: isProduction
        ? winston.format.json()
        : winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp, ...meta }) => {
              const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
              return `${timestamp} ${level}: ${message}${extra}`;
            })
          ),
    }),
    new winston.transports.File({ filename: path.join(LOG_DIR, 'app.log'), ...ROTATION }),
    new winston.transports.File({ filename: path.join(LOG_DIR, 'error.log'), level: 'error', ...ROTATION }),
  ],
});

module.exports = logger;
