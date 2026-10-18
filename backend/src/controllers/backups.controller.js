const asyncHandler = require('../utils/asyncHandler');
const backupService = require('../services/backup.service');

// GET /api/backups
const list = asyncHandler(async (req, res) => {
  const { passphraseSet, passphraseProblem } = backupService.passphraseStatus();
  res.json({
    data: backupService.listBackups(),
    emailConfigured: backupService.emailConfigured(),
    passphraseSet,
    passphraseProblem,
    lastLocal: backupService.getLastLocalStatus(),
    lastEmail: backupService.getLastEmailStatus(),
  });
});

// POST /api/backups/run — local backup only, on-demand rather than waiting
// up to 6h for the next automatic one (e.g. right after a fresh deploy).
const run = asyncHandler(async (req, res) => {
  const result = await backupService.runBackup();
  res.status(201).json({ data: result });
});

// POST /api/backups/email-now — on-demand backup + email, on-demand rather
// than waiting up to 24h for the next automatic one.
const emailNow = asyncHandler(async (req, res) => {
  const result = await backupService.runBackupAndEmail();
  res.status(201).json({ data: result });
});

module.exports = { list, run, emailNow };
