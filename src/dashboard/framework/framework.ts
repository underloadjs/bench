// dashboard/framework/framework.ts — the BenchFramework bundle.
//
// The bundle of configurations + layouts the dashboard hands to EVERY bench
// plugin factory when it loads it (mirrors
// distribution/maths/src/framework/framework.ts):
//
//   export function ModelBenchPlugin(bench: BenchFramework): BenchPlugin {
//       return bench.createModelBench({ id: 'qwen3.8-27b', ... });
//   }
//
// Within the function the plugin describes its rail label and what happens
// when its label is clicked (its panel shows in the content area) — using
// the framework's standard bench recipe, formatting helpers, theme and the
// shared store actions provided here.
//
// IMPORT DIRECTION (one-way, cycle-free):
//   framework.ts → model-kit.ts → types.ts (type-only) + core + context
//   plugins/<Name>.ts → framework.ts (the bundle) — never the reverse.
import { createModelBench } from './model-kit';
import { compileScenarioHelper, createScenario } from './scenario-kit';
import { defineBenchPlugin, type BenchPlugin, type BenchScenarioPlugin, type BenchScenarioSpec, type ModelBenchSpec } from './types';
import { useBenchDashboard } from '../context';
import { benchTheme, formatCount, formatPercent, formatSeconds, formatTokensPerSec, truncateText } from '../utilities';
import { Card } from '../components';

// A plugin FACTORY — the uninvoked function a plugin module exports. The
// plugin list (plugins/index.ts) stores factories UNINVOKED so the dashboard
// can render first and then load them ONE BY ONE after mount (loader.ts);
// loading = calling the factory with the framework bundle.
export type BenchPluginFactory = (bench: BenchFramework) => BenchPlugin;

// A scenario FACTORY — the uninvoked function a scenario module exports
// (dashboard/scenarios/*). Loaded through the same loader, stored in its
// own registry, rendered in the RunBar dropdown.
export type { BenchScenarioFactory } from './types';

// Re-export the model-bench spec type so plugin modules import everything
// they need from the framework barrel.
export type { ModelBenchSpec } from './types';

export type BenchFramework = {
    // The framework's standard bench recipe: builds a complete per-model
    // plugin (rail entry + toolbar + column) from a spec.
    createModelBench: (spec: ModelBenchSpec) => BenchPlugin;
    // The framework's standard scenario recipe: builds a complete scenario
    // plugin (dropdown entry + default execute) from a spec. Scenario
    // factories call `bench.createScenario({ id, label, prompt, ... })`.
    createScenario: (spec: BenchScenarioSpec, execute?: BenchScenarioPlugin['execute']) => BenchScenarioPlugin;
    // Compiles the helper handed to a scenario's execute(): binds the spec +
    // target provider + shared store actions into a ready-to-run object.
    compileHelper: typeof compileScenarioHelper;
    // Shared store actions (pushLog / addReport / setStatus / reset) — the
    // same reactive plumbing the framework sections use.
    useBench: typeof useBenchDashboard;
    // Design tokens + formatting helpers plugins compose their surfaces from.
    theme: typeof benchTheme;
    format: {
        seconds: typeof formatSeconds;
        tokensPerSec: typeof formatTokensPerSec;
        count: typeof formatCount;
        percent: typeof formatPercent;
        truncate: typeof truncateText;
    };
    // Shared card surface for plugin panels.
    Card: typeof Card;
    // Plugin factory helper (single injection point for future concerns).
    definePlugin: typeof defineBenchPlugin;
};

// The singleton bundle passed to every bench plugin factory in plugins/index.ts.
export const BENCH_FRAMEWORK: BenchFramework = {
    createModelBench,
    createScenario,
    compileHelper: compileScenarioHelper,
    useBench: useBenchDashboard,
    theme: benchTheme,
    format: {
        seconds: formatSeconds,
        tokensPerSec: formatTokensPerSec,
        count: formatCount,
        percent: formatPercent,
        truncate: truncateText
    },
    Card,
    definePlugin: defineBenchPlugin
};
