// Single source of truth for the application version of this dashboard:
// the "version" field of packages/underload/bench/package.json.
//
// vite.config.ts and vitest.config.ts read that field and inject it as the
// `__APP_VERSION__` define (Vite substitutes the identifier in the vite
// build and dev server, vitest in test runs — plain globals survive all
// three, whereas `import.meta.env.*` defines get swallowed by vitest's
// runtime env). No hardcoded duplicate of the version ever lives in the UI
// source; `tsc --noEmit` typechecks because the identifier is declared
// below, and the typeof guard keeps this module safe in any context that
// skips the define (e.g. the package consumed as source without a bundler).
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

// The branded product title shown in the top-left header brand cluster
// (dashboard/components/modules/SectionHeader.tsx), on the provider dialog
// and splash (App.tsx), and set as the browser document title (main.tsx):
// "Bench v<version>".
export const PRODUCT_TITLE = `Bench v${APP_VERSION}`;
