// Standalone/CI stand-in for the noobscript config/environment workspace
// package, which is private and not published to npm. The vite, vitest and
// tsconfig mappings prefer the monorepo workspace source when this package
// sits inside the monorepo and fall back to this shim for standalone
// installs (e.g. the GitHub Pages deploy build). Values mirror
// config/environment/src so the dashboard behaves identically in both
// contexts.
export const LOCAL_AREA_NETWORK_HOST_NAME = '192.168.50.109';
export const LOCAL_AREA_NETWORK_DATABASE_PORT = 5000;
export const LOCAL_AREA_NETWORK_STORYBOARD_PORT = 5252;
export const LOCAL_AREA_NETWORK_PROVIDER_PORT = 5500;
