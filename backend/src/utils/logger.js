const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Same directory family as the backups folder — both are operational data
// that lives next to the database, not application code.
const LOG_DIR = path.join(path.dirname(process.env.DATABASE_PATH || './data/urban_trends.db'), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const isProduction = process.env.NODE_ENV === 'production';

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
    new winston.transports.File({ filename: path.join(LOG_DIR, 'app.log') }),
    new winston.transports.File({ filename: path.join(LOG_DIR, 'error.log'), level: 'error' }),
  ],
  // No log-rotation library wired in — app.log and error.log will grow
  // unbounded over time. Fine to start; if this becomes a real disk-space
  // concern, add `winston-daily-rotate-file` as a transport later rather
  // than reinventing rotation here.
});

module.exports = logger;
