import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Every shipped source file counts, not just the ones a test happened to import — otherwise a
      // new untested module would raise the percentage by staying invisible.
      all: true,
      include: ['src/**/*.ts'],
      // dist/ is the compiled copy of src/ (it would count every file twice), tests/ and scripts/
      // are the measuring apparatus, and a .d.ts carries no executable code at all.
      exclude: ['dist/**', 'tests/**', 'scripts/**', '*.config.ts', 'src/**/*.d.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        // Set from the measured state, not from a wish: the suite stands at 97.98% statements /
        // 88.50% branches / 97.10% functions / 97.98% lines. These floors sit just below that, so a
        // regression fails the build while ordinary churn does not — and they stay far above the
        // 80% project minimum, which as a floor here would license a slow decay down to it.
        statements: 97,
        branches: 87,
        functions: 96,
        lines: 97,
        // Business-critical: the OAuth path a Desktop user logs in through. Every line and every
        // branch of it is exercised today, and nothing may ship there on an untested path.
        'src/auth/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/tools/login.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
