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

// Application version: read once from this package's package.json and pinned
// into the bundle as the __APP_VERSION__ define (see src/version.ts) so the
// header can render "Bench v{version}" without bundling package.json into
// the client — same convention as the distribution/* apps (e.g. maths,
// chat-assistant).
const APP_VERSION = (JSON.parse(
    fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string }).version;

export default defineConfig({
    plugins: [react()],
    define: {
        // Compile-time constant — replaced with the literal version string
        // (e.g. "1.0.2") in both dev and build output.
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
