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

export default defineConfig({
    plugins: [react()],
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
