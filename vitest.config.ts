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

export default defineConfig({
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
