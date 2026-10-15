const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('./env'); // loads .env, creates missing secrets, pins DATABASE_PATH to backend/data

const dbPath = process.env.DATABASE_PATH;
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);

// WAL mode: readers don't block the single writer — matters once
// multiple registers are hitting the same DB concurrently.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Without this, a write that lands while another connection briefly holds
// the write lock throws SQLITE_BUSY immediately instead of waiting — and
// an uncaught SQLITE_BUSY inside a request handler or a background sweep
// (see server.js) is exactly the kind of routine, load-related error that
// otherwise takes the whole process down. 5s is generous for a single-file
// SQLite under normal load; a request genuinely stuck longer than that has
// bigger problems than this pragma can paper over.
db.pragma('busy_timeout = 5000');

module.exports = db;
