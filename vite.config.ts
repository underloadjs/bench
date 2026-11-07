// Vite config for the @agentic/bench dashboard dev server.
// Mirrors the distribution/* apps (e.g. comfy-dashboard): react plugin + a
// fixed port so `yarn workspace @agentic/bench dev` always lands in one place.
// The @config/environment alias resolves the workspace config package's
// source when inside the noobscript monorepo, and the vendored local/ shim
// for standalone installs (core/provider.ts imports
// LOCAL_AREA_NETWORK_HOST_NAME and LOCAL_AREA_NETWORK_PROVIDER_PORT from it
// either way).
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { formatBuildStamp } from './src/build-stamp.ts';

// Application version: read once from this package's package.json and pinned
// into the bundle as the __APP_VERSION__ define (see src/version.ts) so the
// header can render "Bench v{version}" without bundling package.json into
// the client — same convention as the distribution/* apps (e.g. maths,
// chat-assistant).
const APP_VERSION = (JSON.parse(
    fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string }).version;

// Build stamp: the build machine's DDHHMM, pinned the same way as
// __APP_BUILD_STAMP__ so the title names the artifact that was built
// ("Bench v{version}(081345)") and never the visitor's clock. GitHub Actions
// runners are UTC, so a CI build stamps the UTC day and time it ran
// (./src/build-stamp.ts).
const APP_BUILD_STAMP = formatBuildStamp(new Date());

export default defineConfig({
    plugins: [react()],
    define: {
        // Compile-time constants — replaced with the literal strings in both
        // dev and build output (e.g. "1.0.2" and "081345").
        __APP_VERSION__: JSON.stringify(APP_VERSION),
        __APP_BUILD_STAMP__: JSON.stringify(APP_BUILD_STAMP)
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
    server: {
        // dashboard dev port (comfy-dashboard owns 8100)
        port: 8200,
        host: true
    },
    build: {
        // Vite resolves outDir relative to root (src/) — emit to the
        // package-level dist/ like before the reorganise.
        outDir: '../dist',
        emptyOutDir: true
    },
    // src/index.html is the dev-app entry (script points at ./main.tsx)
    root: 'src'
});
