// dashboard/plugins/model-bench.ts — the MODEL BENCH plugin.
//
// One bench plugin per model from the provider's v1/models catalog: a
// factory-producing factory (`createModelBenchPlugin`) closes over the
// catalog entry so the dashboard's loader can treat it like any other
// self-contained plugin module. The plugin:
//   - contributes its SIDEBAR LABEL (the model id) to the rail;
//   - shows its live report (progress strip + summary tiles + per-iteration
//     rows, updated progressively as runs settle) when its label is clicked
//     (dashboard.createModelBench's standard recipe);
//   - provides `createProvider` — the model's execution contribution. The
//     RunBar's New Run dispatches the TICKED SCENARIO plugins against the
//     ACTIVE model: the framework compiles the scenario helper with THIS
//     provider (scenario execution moved to dashboard/scenarios/ +
//     framework/scenario-kit.tsx).
//
// Fully self-contained: it imports only from the framework + core. Removing
// a model from the catalog (or a line in index.ts) removes the whole bench
// test without affecting the framework or any other plugin.
import { createHttpProvider, DEFAULT_PROVIDER_URL, type ProviderModel } from '../../core';
import type { BenchFramework, BenchPluginFactory, ModelBenchSpec } from '../framework';

// Per-model bench configuration layered on top of the catalog entry.
export type ModelBenchOptions = {
    // The prompt sent on every iteration.
    prompt: string;
    // Iterations per New Run (default 3).
    iterations?: number;
    // Concurrent iterations in flight (default 1 = sequential).
    concurrency?: number;
    // Provider base URL override (defaults to the LAN provider origin).
    baseUrl?: string;
    // Rail glyph (defaults to '⚡').
    icon?: string;
    // Rail/toolbar label override (defaults to the raw catalog id — see
    // modelDisplayName in plugins/index.ts for the "name (org)" shortening).
    label?: string;
    // Transport override — builds the BenchProvider for this model.
    // DEFAULT: createHttpProvider against the LAN provider service. The
    // offline demo fleet (demo-catalog.ts) injects createDemoTransport here
    // so stories/tests run a full benchmark without touching the network.
    createProvider?: ModelBenchSpec['createProvider'];
};

/**
 * Builds an UNINVOKED plugin factory for one catalog model. The dashboard
 * loads it like any other plugin module: `factory(BENCH_FRAMEWORK)`.
 *
 * @param model   - The catalog entry; `model.id` is the completion routing key.
 * @param options - Prompt + iteration plan + optional transport override.
 */
export function createModelBenchPlugin(model: ProviderModel, options: ModelBenchOptions): BenchPluginFactory {
    // The spec closes over the catalog entry — the factory itself stays
    // pure (same inputs → same plugin description), which is what makes
    // StrictMode's double-invoke harmless.
    const spec: ModelBenchSpec = {
        // The FULL catalog id stays the registry/routing key — the provider
        // routes completions by id; only the DISPLAY label is shortened.
        id: model.id,
        label: options.label ?? model.id,
        icon: options.icon ?? '⚡',
        prompt: options.prompt,
        iterations: options.iterations,
        concurrency: options.concurrency,
        // RESOLVED endpoint: the rail entry + panel Endpoint field autofill
        // read it off the spec (undefined → the standard LAN provider URL).
        baseUrl: options.baseUrl ?? DEFAULT_PROVIDER_URL,
        // Bind the HTTP provider to THIS model id on the provider service
        // (options.createProvider lets tests/dev swap in a stub transport).
        createProvider: options.createProvider ?? (() => createHttpProvider(model.id, { baseUrl: options.baseUrl }))
    };
    return (bench: BenchFramework) => bench.createModelBench(spec);
}
