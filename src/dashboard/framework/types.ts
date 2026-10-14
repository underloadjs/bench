// dashboard/framework/types.ts — the bench plugin contract.
//
// ARCHITECTURE (mirrors distribution/maths/src/framework — see that tree for
// the full pattern reference: types.ts / framework.ts / registry.ts /
// loader.ts / host.tsx / store.tsx / plugins/index.ts):
//
//   The dashboard is a FRAMEWORK. It owns the app shell (header bar, stats
//   strip, main band, footer — dashboard/BenchDashboard.tsx), the shared
//   reactive store (dashboard/context/store.ts) and the display sections
//   (dashboard/components/modules/*).
//
//   Every BENCH TEST is a PLUGIN: a factory function like
//   ModelBenchPlugin(bench) that takes in the dashboard's configurations +
//   layouts when the dashboard loads it (plugins/index.ts stores the
//   factories UNINVOKED; framework/loader.ts invokes them one by one after
//   the shell renders) and returns a BenchPlugin describing:
//
//     - its SIDEBAR LABEL (entries — what the plugin rail shows; clicking
//       TOGGLES the model's selection),
//     - its COLUMN (the panel — rendered once per SELECTED model, side by
//       side: target fields + benchmark entries),
//     - its `createProvider` — the execution binding the dispatcher (the
//       framework's Scenario Execution header) compiles into each scenario
//       helper for every selected plugin (bench tests execute at request).
//
//   A plugin module is FULLY self-contained: its runner logic, its spec and
//   its factory live in one file under dashboard/plugins/, and it may only
//   import from the framework + core — never from another plugin. Deleting a
//   plugin's file and its line in plugins/index.ts removes the whole bench
//   test without affecting the framework or any other plugin.
//
// STATE: plugins keep NO persistent state of their own. Everything they
// produce (reports, logs, status) flows through the SHARED framework store
// (dashboard/context/store.ts), so framework sections (leaderboard,
// timeline, console) render plugin output without knowing any plugin.

import type React from 'react';
import type { BenchmarkReport, BenchProvider } from '../../core';
import type { BenchEntry, BenchLogTone } from '../context';
// TYPE-ONLY circular import (types.ts ↔ framework.ts): BenchScenarioFactory
// mirrors BenchPluginFactory's `(bench) => plugin` shape, and both bundles
// are declared in framework.ts. Type-only cycles are erased at runtime.
import type { BenchFramework } from './framework';

// Unique plugin identifier. Used as registry key and React key, so it must be
// stable and unique across all plugins.
export type BenchPluginId = string;

// ── Model-bench spec ─────────────────────────────────────────────────────────
// The declarative description a model-bench plugin hands to
// bench.createModelBench: everything the framework needs to render the
// plugin's rail entry, toolbar, panel and run action.
// `id` MUST be a model id from the provider's v1/models catalog — that
// catalog IS the bench fleet.
export type ModelBenchSpec = {
    // Registry key — the provider model id (routing key for completions).
    id: BenchPluginId;
    // Rail label (defaults to the model id).
    label?: string;
    // Rail glyph.
    icon?: string;
    // The prompt sent on every iteration.
    prompt: string;
    // Number of iterations per New Run (default 3).
    iterations?: number;
    // Concurrent iterations in flight (default 1 = sequential).
    concurrency?: number;
    // OpenAI-compatible base URL this model's completions POST hits — the
    // RESOLVED value (options.baseUrl ?? DEFAULT_PROVIDER_URL at factory
    // time, dashboard/plugins/model-bench.ts). Autofills the model column's
    // Endpoint target field and is the dispatch fallback for untouched
    // columns.
    baseUrl?: string;
    // Build the BenchProvider for this model (injected by the plugin module
    // so tests can stub the transport; production passes createHttpProvider).
    createProvider: () => BenchProvider;
};

// ── Sidebar ───────────────────────────────────────────────────────────────────
// One selectable entry the dashboard merges into the plugin rail. Clicking an
// entry TOGGLES the owning plugin's selection (multi-select — every selected
// model renders a column and is benchmarked by one New Run).
export type BenchPluginEntry = {
    // Stable key for this entry (must be unique within the plugin).
    id: string;
    // Human label rendered in the rail.
    label: string;
    // Decorative glyph shown in the entry's icon chip.
    icon?: string;
    // Screen-reader text when the label alone is ambiguous (defaults to label).
    ariaLabel?: string;
    // THIS MODEL'S BINDING (model-bench entries only): the model id +
    // endpoint the column's target fields autofill from and the dispatcher
    // falls back to for untouched columns (framework/host.tsx + model column
    // in framework/model-kit.tsx). Optional — non-model plugins omit both.
    model?: string;
    endpoint?: string;
};

// ── Runtime context ──────────────────────────────────────────────────────────
// What every plugin component receives: its OWN entry id plus the shared
// framework state (plugins read reports/logs/entries from the shared store
// via useBenchDashboard). The columns host additionally injects the loaded
// scenario plugins and the external-runner override — see host.tsx.
export type BenchPluginContext = {
    // The plugin's unique id (registry key).
    pluginId: BenchPluginId;
    // The id of the currently selected entry of this plugin.
    entryId: string;
    // The plugin's declared rail entries.
    entries: BenchPluginEntry[];
    // The loaded SCENARIO plugins (dashboard/scenarios/) — the framework's
    // execution host renders their specs in its dropdown and dispatches
    // their execute(). Optional — absent before the scenario loader has
    // committed anything.
    scenarios?: BenchScenarioPlugin[];
    // EXTERNAL RUNNER override: when the dashboard host received an onNewRun
    // prop, Run dispatches there instead of creating in-dash entries.
    onRun?: () => void;
};

// ── Slots ─────────────────────────────────────────────────────────────────────
// Components a plugin can mount into the framework's slots. All receive the
// plugin's runtime context.
export type BenchPluginToolbarComponent = React.ComponentType<{
    context: BenchPluginContext;
}>;

export type BenchPluginPanelComponent = React.ComponentType<{
    context: BenchPluginContext;
}>;

// ── The plugin definition itself ─────────────────────────────────────────────
export type BenchPlugin = {
    // Unique registry key + React key.
    id: BenchPluginId;
    // Human-readable name (shown in the plugin list / debug surfaces).
    name: string;
    // Entries the framework merges into its left rail. A bench plugin
    // declares exactly ONE entry — its own rail label.
    entries: BenchPluginEntry[];
    // Rendered into the content band's toolbar card while this plugin is
    // first in the selection. Optional — a plugin without controls renders
    // no toolbar card.
    toolbar?: BenchPluginToolbarComponent;
    // The plugin's COLUMN — rendered once per SELECTED plugin, side by side
    // in the columns row (framework/host.tsx BenchPluginColumnsHost).
    // Required — this IS the dashboard's rendering contribution.
    panel: BenchPluginPanelComponent;
    // Builds the BenchProvider for the plugin's model (model-bench plugins
    // only). The dispatcher (the framework's Scenario Execution header)
    // reads this off every SELECTED plugin so a scenario can be executed
    // against ANY selected model without the scenario knowing the
    // transport — the framework compiles it into the helper.
    createProvider?: () => BenchProvider;
};

// ── Scenario plugins ─────────────────────────────────────────────────────────
// THE PLUGIN UPGRADE: every BENCHMARK SCENARIO is a plugin. Where a
// model-bench plugin owns ONE model's rail entry + panel, a scenario plugin
// owns one repeatable TEST (the prompt + iteration plan) that can be run
// against any model in the fleet. Scenarios are fully standalone modules
// under dashboard/scenarios/ — removing a file + its line in that barrel
// removes the scenario from the dropdown without touching anything else.
export type BenchScenarioSpec = {
    // Registry key (dropdown item key). Stable + unique across scenarios.
    id: BenchPluginId;
    // Dropdown label ("Short Story", "Summarization", …).
    label: string;
    // Decorative glyph shown next to the dropdown item.
    icon?: string;
    // One-line description surfaced as the dropdown item's tooltip.
    description?: string;
    // The prompt sent on every iteration.
    prompt: string;
    // Iterations per run (default 3).
    iterations?: number;
    // Concurrent iterations in flight (default 1 = sequential).
    concurrency?: number;
};

// The minimal slice of the shared store a scenario may drive. Structural
// (a Pick-shaped subset of BenchDashboardActions) so tests can pass plain
// recorder objects instead of mounting the React tree.
export type BenchScenarioActions = {
    pushLog: (text: string, tone?: BenchLogTone) => void;
    addReport: (report: BenchmarkReport) => void;
    // Entry-scoped writes: progress snapshots, partial reports and the
    // final status flip all land on ONE benchmark entry (each New Run
    // click creates its own entry — see BenchEntry in context/store.ts).
    updateEntry: (entryId: string, patch: Partial<BenchEntry>) => void;
};

// THE COMPILED HELPER — the framework builds one per benchmark ENTRY at
// launch time and hands it to the scenario's execute(). Everything a
// scenario needs to actually run is pre-wired here: the target provider,
// the entry it reports into, the store actions, a `run` that drives the
// core engine while feeding progressive feedback (logs + live progress +
// partial reports) into that entry, and the entry's cancellation signal.
// A scenario therefore only calls `helper.run()`.
export type BenchScenarioHelper = {
    // The scenario spec this helper was compiled for.
    scenario: BenchScenarioSpec;
    // The provider bound to the model the run targets (compiled from the
    // ACTIVE rail plugin's createProvider).
    provider: BenchProvider;
    // The benchmark entry this helper reports into (created by launchScenario).
    entryId: string;
    // ENTRY CANCELLATION signal: aborted when the operator cancels the entry
    // (the entry card's hover CANCEL button → store cancelEntry action).
    // helper.run() forwards it to runBench (in-flight requests abort, queued
    // runs are skipped); custom executors check `signal.aborted` between
    // their own steps and pass it into provider calls.
    signal: AbortSignal;
    // The EFFECTIVE plan at compile time (spec defaults < the plan pinned by
    // the panel's selects). Custom scenarios (e.g. the growing-context
    // conversation test) read this instead of calling run() — iterations
    // maps to growth steps, concurrency to parallel conversations.
    plan: { prompt: string; iterations: number; concurrency: number };
    // Executes the bench: core runBench() with the scenario's plan (the
    // optional argument overrides prompt/iterations/concurrency for this
    // call only). Resolves with the final BenchmarkReport.
    run: (plan?: Partial<Pick<BenchScenarioSpec, 'prompt' | 'iterations' | 'concurrency'>>) => Promise<BenchmarkReport>;
    // Raw store actions — escape hatch for scenarios that orchestrate
    // several runs or custom logging themselves.
    actions: BenchScenarioActions;
};

// A loaded scenario plugin: the spec plus its EXECUTE action. The default
// execute (built by createScenario) just calls helper.run(); custom
// scenarios can orchestrate multiple helper.run() calls or extra logging.
export type BenchScenarioPlugin = {
    // Unique registry key (matches spec.id).
    id: BenchPluginId;
    // Human-readable name (debug surfaces / aria labels).
    name: string;
    // The declarative scenario description (dropdown entry + run plan).
    spec: BenchScenarioSpec;
    // Invoked by the dispatcher when this scenario is ticked and New Run is
    // pressed. Receives the compiled helper.
    execute: (helper: BenchScenarioHelper) => void | Promise<unknown>;
};

// The UNINVOKED factory a scenario module exports — same loading pattern as
// the model fleet (loader invokes each with the BENCH_FRAMEWORK bundle).
export type BenchScenarioFactory = (bench: BenchFramework) => BenchScenarioPlugin;

// Factory helper with full type inference for the scenario contract (the
// scenario counterpart of defineBenchPlugin — a single injection point for
// future cross-cutting concerns like validation or telemetry).
export function defineBenchScenario(scenario: BenchScenarioPlugin): BenchScenarioPlugin {
    return scenario;
}

// Factory helper with full type inference for the plugin contract. Every
// plugin module exports `export function MyBench(bench)` — the factory
// exists purely so future cross-cutting concerns (validation, dev-time
// warnings, telemetry) have a single injection point.
export function defineBenchPlugin(plugin: BenchPlugin): BenchPlugin {
    return plugin;
}
