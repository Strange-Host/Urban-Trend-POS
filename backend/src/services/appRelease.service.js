const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const jwt = require('jsonwebtoken');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const settingsService = require('./settings.service');
const { parse, isVersion, compare } = require('../utils/appVersion');

// Hosting the Android app (APK) on the server itself, so a new phone installs from a link and the app can update itself.
//
//  - The APK lives next to the database, in an `apk/` folder (the same persistent volume as the data and backups).
//  - Uploading one is an owner action (permission app.manage). It becomes the "latest" version; the minimum is untouched
//    (raise it from Settings only when old builds must stop).
//  - Downloading needs a signed-in person (bearer token: the app updating itself) OR a short-lived signed link the owner makes
//    for a new phone's browser (shared as a link or a QR code). Nothing about the file is public.
//
// Never trust the file name: the path is built from a parsed version number, so there is no way to name a path.

const APK_DIR = path.join(path.dirname(process.env.DATABASE_PATH || './data/urban_trends.db'), 'apk');
const MAX_BYTES = 200 * 1024 * 1024;          // an Expo release APK is tens of MB; this only stops a runaway upload
const LINK_DAYS = 7;
const PURPOSE = 'apk-download';

const normalize = (v) => { const p = parse(v); return p ? p.join('.') : null; };
const fileFor = (version) => path.join(APK_DIR, `urbantrends-${normalize(version)}.apk`);

/** Streams the request body to disk as the APK for `version`. Returns { version, sizeBytes, latestVersion }. */
async function saveUpload({ req, version, userId }) {
  if (!isVersion(version)) throw new ApiError(400, 'version must be a number such as 1.2.0 (?version=1.2.0).');
  const clean = normalize(version);
  fs.mkdirSync(APK_DIR, { recursive: true });
  const tmp = path.join(APK_DIR, `.upload-${process.pid}-${Date.now()}.part`);
  let bytes = 0; let head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) return cb(new ApiError(413, `The file is larger than ${MAX_BYTES / 1024 / 1024} MB.`));
      if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4 - head.length)]);
      return cb(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, fs.createWriteStream(tmp, { mode: 0o640 }));
    // An APK is a zip file: it starts "PK". This catches the wrong file (or an empty body), not a malicious one - the owner is
    // the only person who can reach this, and phones check the signature themselves.
    if (bytes < 1024 || head.toString('latin1', 0, 2) !== 'PK') throw new ApiError(400, 'That does not look like an Android app file (.apk).');
    fs.renameSync(tmp, fileFor(clean));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  const s = settingsService.getAll();
  const latest = compare(clean, s.app_latest_version) === 1 ? clean : s.app_latest_version;
  if (latest !== s.app_latest_version) settingsService.setMany({ app_latest_version: latest }, userId);
  logStaffAction({ staffId: userId, action: 'create', entityType: 'app_release', entityId: 0, after: { version: clean, sizeBytes: bytes } });
  return { version: clean, sizeBytes: bytes, latestVersion: latest };
}

/** Absolute path of the latest APK, or null if none has been uploaded for the latest version. */
function latestFile() {
  const v = settingsService.getAll().app_latest_version;
  if (!isVersion(v)) return null;
  const f = fileFor(v);
  return fs.existsSync(f) ? { path: f, version: normalize(v) } : null;
}

function makeLink({ origin, userId }) {
  const latest = latestFile();
  if (!latest) throw new ApiError(404, 'No app file has been uploaded for the latest version yet.');
  const token = jwt.sign({ purpose: PURPOSE, v: latest.version, by: userId }, process.env.JWT_SECRET, { expiresIn: `${LINK_DAYS}d` });
  const { exp } = jwt.decode(token);
  return { url: `${origin}/api/v1/app/download?t=${encodeURIComponent(token)}`, expiresAt: new Date(exp * 1000).toISOString(), version: latest.version };
}

function verifyLink(token) {
  try {
    const p = jwt.verify(String(token || ''), process.env.JWT_SECRET);
    if (p.purpose !== PURPOSE) throw new Error('wrong purpose');
    return p;
  } catch {
    throw new ApiError(401, 'This download link is invalid or has expired. Ask the owner for a new one.', null, 'LINK_EXPIRED');
  }
}

module.exports = { APK_DIR, MAX_BYTES, saveUpload, latestFile, makeLink, verifyLink, fileFor };
