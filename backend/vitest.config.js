const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false, // tests share one on-disk SQLite file per run; keep them sequential
  },
});
