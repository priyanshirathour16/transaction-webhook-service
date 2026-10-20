import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // Integration tests share one database; files run serially, tests within a file stay ordered.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reporter: ['text-summary', 'text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Set just under the current level (about 99 / 97 / 97 / 100): a regression fails CI.
      thresholds: { statements: 95, branches: 90, functions: 90, lines: 97 },
    },
  },
});
