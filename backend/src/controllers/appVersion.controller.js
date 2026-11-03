const asyncHandler = require('../utils/asyncHandler');
const settingsService = require('../services/settings.service');
const { compare, isVersion } = require('../utils/appVersion');

// GET /api/v1/app/version[?current=1.0.0]
// Public on purpose: the app calls it before anyone has signed in, and a phone whose app is too old to sign in must still
// be able to read it to find out why and where to download the update. It carries nothing private.
//
// `current` is the version of the app asking. When it is given the answer also says what to do about it:
//   updateRequired   below the minimum  -> the app shows a blocking update screen with downloadUrl
//   updateAvailable  below the latest   -> the app offers the update but lets the person carry on
// A missing or unreadable `current` gives both as false (the server never blocks an app it cannot place).
const get = asyncHandler(async (req, res) => {
  const s = settingsService.getAll();
  const minimum = isVersion(s.app_min_version) ? s.app_min_version : '1.0.0';
  const latest = isVersion(s.app_latest_version) && compare(s.app_latest_version, minimum) >= 0 ? s.app_latest_version : minimum;
  const current = typeof req.query.current === 'string' ? req.query.current : null;
  const vsMin = current ? compare(current, minimum) : null;
  const vsLatest = current ? compare(current, latest) : null;

  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    minimumVersion: minimum,
    latestVersion: latest,
    downloadUrl: s.app_download_url || null,
    updateRequired: vsMin === -1,
    updateAvailable: vsLatest === -1,
  });
});

module.exports = { get };
