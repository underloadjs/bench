// dashboard/plugins/demo-catalog.ts — offline catalog-shaped model list.
//
// The dev server / storybook has no API access to the real inference
// provider, so this module mimics the EXACT shape of
// GET {provider}/models (core/provider.ts ProviderModel /
// runtime/endpoint/provider/private/models/service-route.ts response):
// { id, object: 'model', created, owned_by, context_length }.
//
// These entries feed the offline fallback PLUGINS list (see index.ts) and
// the demo transport in demo-transport.ts, which streams word-by-word so
// the dashboard's timeline bars and console animate exactly like a real
// benchmark. Determinism: the sleep primitive is injectable (tests pass an
// instant no-op).
import type { ProviderModel } from '../../core';

// Synthetic catalog: distinct latency profiles (TTFT + step rate) so the
// leaderboard has a clear best → worst narrative. `failIteration` layers a
// flaky-iteration failure onto the matching model (exercises the failed-run
// rendering — run 5 of 6 for the slowest profile).
export type DemoCatalogModel = ProviderModel & {
    // Time to first token, milliseconds
    ttftMs: number;
    // Milliseconds between streamed word chunks (inversely related to speed)
    stepMs: number;
    // How many words the completion contains (→ completion token estimate)
    totalWords: number;
    // Every Nth iteration fails (1-indexed); undefined = never fails.
    failIteration?: number;
};

// Ordered best → worst (champion first, matching the leaderboard's sort).
export const DEMO_CATALOG_MODELS: DemoCatalogModel[] = [
    { id: 'echo-fast-27b', object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144, ttftMs: 420, stepMs: 8, totalWords: 120 },
    { id: 'echo-mid-32b', object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144, ttftMs: 610, stepMs: 13, totalWords: 120 },
    { id: 'echo-slow-flash', object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144, ttftMs: 900, stepMs: 20, totalWords: 120, failIteration: 5 }
];
