// dashboard/plugins/index.ts — THE BENCH PLUGIN LIST — the single
// registration point of the dashboard.
//
// Every bench test is a PLUGIN: a factory FUNCTION that the dashboard loads
// by calling it with the framework's configurations + layouts
// (BENCH_FRAMEWORK). Within each function the plugin describes its rail
// label and what happens when its label is clicked (its panel shows in the
// content area).
//
// LOADING ORDER — the dashboard loads FIRST, the plugins SECOND: the
// factories below are stored UNINVOKED (a BenchPluginFactory, not a
// BenchPlugin). The dashboard renders its shell + the first plugin
// immediately, then loads the remaining factories ONE BY ONE after mount —
// see framework/loader.ts (useBenchPluginLoader).
//
// THE FLEET COMES FROM THE PROVIDER: the model list is fetched at runtime
// from GET {user-supplied base URL}/models (core/provider.ts
// fetchProviderModels — ANY OpenAI-compatible v1/models endpoint works) —
// that catalog IS the list of bench plugins. The buildFleetFactories helper
// below converts catalog entries into plugin factories, binding each one to
// the SAME base URL so completions hit the provider the catalog came from.
// STATIC_PLUGINS below is the offline fallback (and the fixture fleet for
// stories/tests) so the dashboard still renders when no provider is loaded.
//
// This is the ONLY file that changes when adding or removing a bench test:
//
//   ADD     a static bench test:  create dashboard/plugins/<Name>.ts
//                                 exporting the factory function and add
//                                 one line to the list below.
//   DELETE  a bench test:         delete its file and remove its line.
//                                 Nothing else in the app references it.
import { DEMO_CATALOG_MODELS } from './demo-catalog';
import { createDemoTransport } from './demo-transport';
import { createModelBenchPlugin } from './model-bench';
import type { ProviderModel } from '../../core';
import type { BenchPluginFactory } from '../framework';

// The default bench configuration shared by every model plugin: each New Run
// sends this prompt, 3 iterations, strictly sequential (keeps the console
// narrative readable; per-model concurrency would be 3 here). Same short
// story probe as the short-story scenario (scenarios/short-story.ts) — the
// 1000-word cap keeps the long-form generation bounded.
export const BENCH_PROMPT = 'Write me a short story about a lighthouse keeper. Maximum of 1000 words.';
export const BENCH_ITERATIONS = 3;
export const BENCH_CONCURRENCY = 1;

// ── Display-name helpers (mirrors chat-assistant modelLabel, ChatAssistantApp.tsx:1494) ──

// Strips the organisation/provider prefix from a catalog id:
// "modal/kimi-k3" → "kimi-k3". The FULL id remains the routing key — the
// provider registry is keyed by id — so only labels shorten, never the
// value sent back on chat/completions.
export const stripModelPrefix = (id: string): string => {
    const slash = id.lastIndexOf('/');
    return slash >= 0 ? id.slice(slash + 1) : id;
};

// Human label for the rail/toolbar/panel: "modal/kimi-k3" displays as
// "kimi-k3 (modal)" — the stripped name up front (what operators scan for),
// the provider in parentheses (the natural disambiguator when several
// providers serve the same base model, e.g. modal/merge/kimi-k3). Bare ids
// (no slash) pass through unchanged.
export const modelDisplayName = (id: string): string => {
    const slash = id.lastIndexOf('/');
    if (slash < 0) return id;
    return `${id.slice(slash + 1)} (${id.slice(0, slash)})`;
};

// Converts one catalog entry into an UNINVOKED plugin factory. This is the
// runtime path the App wires from fetchProviderModels() — a newly registered
// provider model appears as a bench plugin automatically, with no code
// change here.
//
// `baseUrl` — the OpenAI-compatible endpoint the catalog was loaded from.
// It is forwarded to createHttpProvider so the bench POSTs completions to
// the SAME provider the catalog came from (defaults to the LAN origin when
// omitted).
export const catalogToPluginFactory = (model: ProviderModel, baseUrl?: string): BenchPluginFactory =>
    createModelBenchPlugin(model, {
        prompt: BENCH_PROMPT,
        iterations: BENCH_ITERATIONS,
        concurrency: BENCH_CONCURRENCY,
        // Shortened display label ("kimi-k3 (modal)"); spec.id keeps the
        // full "modal/kimi-k3" routing key.
        label: modelDisplayName(model.id),
        baseUrl
    });

// Maps the whole catalog to ordered plugin factories, binding every plugin
// to the provider base URL the catalog came from (see catalogToPluginFactory).
//
// SORT ORDER: by the STRIPPED model name (not the raw org-prefixed id), so
// the rail reads kimi-k3 → llama → qwen regardless of provider prefixes, and
// the same base model served by several providers lists adjacently. Stable:
// ties (identical stripped names) keep catalog order.
export const catalogToPluginFactories = (models: ProviderModel[], baseUrl?: string): BenchPluginFactory[] =>
    [...models]
        .sort((a, b) => stripModelPrefix(a.id).localeCompare(stripModelPrefix(b.id)))
        .map((model) => catalogToPluginFactory(model, baseUrl));

// ── Offline fallback fleet ───────────────────────────────────────────────────
// Catalog-shaped demo models (see demo-catalog.ts) bound to the OFFLINE demo
// transport (demo-transport.ts — synthetic streaming, no network) so the
// dashboard, stories and tests render and EXECUTE a full bench fleet without
// a live provider. Ordered best → worst so the leaderboard has a clear
// champion.
const demoFactories = DEMO_CATALOG_MODELS.map((model) =>
    createModelBenchPlugin(model, {
        prompt: BENCH_PROMPT,
        iterations: BENCH_ITERATIONS,
        concurrency: BENCH_CONCURRENCY,
        // Offline transport: deterministic streaming mock, injectable sleep
        createProvider: () => createDemoTransport(model)
    })
);

// All installed bench plugins, in display/loading order. UNINVOKED
// factories — the dashboard loads each one by calling it with its framework
// bundle, one by one after the dashboard has rendered (framework/loader.ts);
// each loaded plugin then contributes its rail entry, toolbar, panel and
// run action.
export const PLUGINS: BenchPluginFactory[] = demoFactories;
