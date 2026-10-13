// core — benchmark engine public surface.
// types.ts        → data shapes (BenchProvider / BenchRun / BenchSummary / BenchmarkReport)
// runner.ts       → runBench: executes iterations and produces a BenchmarkReport
// summarize.ts    → summarizeRuns: pure stats aggregation (safe to use outside the runner)
// provider.ts     → DEFAULT_PROVIDER_URL + fetchProviderModels: the LAN model
//                   catalog (v1/models) IS the bench fleet; createHttpProvider
//                   binds a BenchProvider to one of those ids.
export * from './types';
export * from './runner';
export * from './summarize';
export * from './provider';