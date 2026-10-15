// pm2 process supervisor config (Phase 0.4 of the fix/patch/upgrade plan).
//
// Why this exists: server.js's uncaughtException/unhandledRejection
// handlers (0.3) deliberately exit the process rather than trying to keep
// running in an unknown state — that's only safe if something restarts it
// automatically afterward. Without a supervisor, "exit and let something
// restart me" just means "exit."
//
// Usage:
//   npm install -g pm2
//   cd backend && pm2 start ecosystem.config.js
//   pm2 save && pm2 startup     # also survives a full server reboot
//
// If you'd rather use systemd instead of pm2, see
// urban-trends-pos-backend.service in this same directory — pick ONE of
// the two, not both.
module.exports = {
  apps: [
    {
      name: 'urban-trends-pos-backend',
      script: './src/server.js',
      cwd: __dirname,
      instances: 1, // a single SQLite file has one writer — do not run multiple instances against it
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10, // beyond this in a short window, pm2 stops trying — see min_uptime
      min_uptime: '30s', // a restart that dies again within 30s counts against max_restarts (crash-looping protection)
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
      },
      // stdout/stderr already go through backend/logs via the app's own
      // logger; these are pm2's own process-level logs (startup, restarts).
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
