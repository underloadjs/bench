// Vitest config for @agentic/bench — mirrors the distribution/* apps
// (e.g. chat-assistant): jsdom + globals because the package contains a
// React dashboard (App.test.tsx renders with @testing-library/react) and
// storybook-based interaction tests (BenchDashboard.test.tsx) that rely on
// the global describe/it APIs.
// Test discovery stays scoped to this package's src/ tree (core/, dashboard/,
// and the dev app shell all live under src/ now) so vitest never picks up
// files from neighbouring workspaces.
// The @config/environment alias resolves the workspace package's SOURCE (its
// main field points at src/index.ts) when inside the noobscript monorepo,
// and the vendored local/ shim for standalone installs — either way the
// alias pins that behaviour for vitest's vite pipeline.
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Mirror vite.config.ts's `__APP_VERSION__` define so the tests resolve the
// application version from the same single source (this package's
// package.json) the shipped bundle does — see src/version.ts. A plain global
// define is used (not `import.meta.env.APP_VERSION`) because vitest's runtime
// materializes `import.meta.env` and swallows env-scoped defines in test runs
// (same convention as distribution/chat-assistant/vitest.config.ts).
const APP_VERSION = (JSON.parse(
    fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string }).version;

export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION)
    },
    resolve: {
        alias: {
            '@config/environment': fs.existsSync(
                path.resolve(__dirname, '../../../config/environment/src/index.ts')
            )
                ? path.resolve(__dirname, '../../../config/environment/src/index.ts')
                : path.resolve(__dirname, 'local/config/environment.ts')
        }
    },
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        passWithNoTests: true
    }
});
