// Barrel export for the BENCH FRAMEWORK.
//
// The framework is everything the bench plugins USE but none of them OWN:
// the plugin contract (types), the registry + slot hosts (registry / host),
// the progressive plugin loader (loader), the standard model-bench recipe
// (model-kit), the scenario recipe + compiled helper (scenario-kit) and the
// BENCH_FRAMEWORK bundle handed to every plugin factory (framework.ts).
export * from './types';
export * from './registry';
export * from './loader';
export * from './host';
export * from './model-kit';
export * from './scenario-kit';
export * from './framework';
