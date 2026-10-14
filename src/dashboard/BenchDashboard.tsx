// dashboard/BenchDashboard.tsx — the @agentic/bench dashboard orchestrator.
//
// The dashboard is a FRAMEWORK HOST (mirrors
// distribution/maths/src/components/MathsDashboard.tsx). It contains no bench
// logic of its own — the bench tests live in TWO plugin families, both loaded
// from the framework:
//
//   MODEL plugins    dashboard/plugins/    → the rail (one entry per model)
//   SCENARIO plugins dashboard/scenarios/  → the execution header's dropdown
//                                           (one entry per benchmark
//                                           scenario; several can be ticked
//                                           and benchmarked TOGETHER)
//
//   plugins/index.ts      → the ordered list of UNINVOKED model factories
//   scenarios/index.ts    → the ordered list of UNINVOKED scenario factories
//   framework/loader      → loads both families one by one after the shell
//                           renders
//   framework/registry    → reconciles the model selection (multi-select)
//   framework/host        → mounts rail entries (toggle-select), the
//                           Scenario Execution header (run controls +
//                           multi-model dispatch) and the model columns
//   framework/types       → the plugin + scenario contracts
//   framework/scenario-kit→ compiles helpers + launches benchmark entries
//
// THE RUN FLOW: execution is SEPARATED from the models. The run controls
// (scenario dropdown + plan selects + New Run) live ONCE in the framework's
// "Scenario Execution" header, directly above the model columns. Each click
// fans out across EVERY selected model (the rail is MULTI-SELECT — one
// column each) × every ticked scenario (one entry each) and launches them IN
// PARALLEL — every entry updates progressively (per-run progress + partial
// reports) via its compiled helper (framework/scenario-kit.ts).
//
// Visual layout (clean, card-based — design tokens in
// dashboard/utilities/theme.ts):
//
// ┌────────────────────────────────────────────────────────────────────────┐
// │ B  Bench / MODEL BENCHMARK                        [theme] [● IDLE]     │
// ├────────────────────────────────────────────────────────────────────────┤
// │ ┌──────────────┐ ┌──────────────────────────────────────────────────┐  │
// │ │ BENCH TESTS  │ │ SCENARIO EXECUTION   [scenario ▾][iters][conc]│  │
// │ │ (multi-      │ │                     [New Run]                 │  │
// │ │  select      │ │ <ticked scenario description + prompt>        │  │
// │ │  models)     │ │ ───────────────────────────────────────       │  │
// │ │              │ │ ┌────────────┬────────────┬────────────┐      │  │
// │ │              │ │ │ Model 1    │ Model 2    │ Model 3    │      │  │
// │ │              │ │ │ <entries>  │ <entries>  │ <entries>  │      │  │
// │ │              │ │ └────────────┴────────────┴────────────┘      │  │
// │ └──────────────┘ └──────────────────────────────────────────────────┘  │
// ├────────────────────────────────────────────────────────────────────────┤
// │ PROMPT  "Write me…"      2 running · 3 models · 18/19 runs · done     │
// └────────────────────────────────────────────────────────────────────────┘

import React from 'react';
import { prototypeComponent, styledComponent } from '@presource/react';
import type { BenchmarkReport } from '../core';
import type { BenchDashboardStatus, BenchEntry, BenchLogEntry } from './context';
import { BenchContextProvider, useBenchDashboard } from './context';
import { benchTheme, useBenchThemeSync } from './utilities';
import { SectionHeader, BottomBar } from './components';
import {
    BENCH_FRAMEWORK,
    useBenchPluginLoader,
    useBenchPluginRegistry,
    BenchPluginRailHost,
    BenchScenarioExecutionHost,
    BenchPluginColumnsHost,
    type BenchPluginFactory,
    type BenchScenarioFactory
} from './framework';
import { PLUGINS } from './plugins';
import { SCENARIOS } from './scenarios';

// Outer shell: light page background, the one full-height flex column
const DashboardShell = styledComponent('div', {
    height: '100%',
    width: '100%',
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: benchTheme.background,
    color: benchTheme.textPrimary,
    // the page's base font — children override per-element where needed
    fontFamily: benchTheme.sansFont
});

// The main content band: rail | execution + model columns (the former right
// column — leaderboard / timeline / console — and the fleet stats strip were
// removed). Generous padding keeps the content card clear of the
// header/rail/footer.
const MainBand = styledComponent('main', {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'row',
    gap: 20,
    padding: '20px 28px 24px 28px',
    overflow: 'hidden'
});

// Plugin rail column: the model list (multi-select; grows as plugins load
// one by one)
const RailColumn = styledComponent('div', {
    flex: '0 0 220px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
    overflowY: 'auto'
});

// Right column: the Scenario Execution header (run controls + dispatch) and
// the model columns row, stacked and scrollable
const PluginColumn = styledComponent('div', {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    overflowY: 'auto'
});

export type BenchDashboardProps = {
    // Latest finished BenchmarkReport per benchmarked model (legacy fleet
    // view — feeds the footer roll-up; per-model run history lives in
    // `entries`)
    reports?: BenchmarkReport[];
    // Pre-seeded benchmark entries (each New Run click appends live ones)
    entries?: BenchEntry[];
    // Pre-filled console feed (live appends come through the store instead)
    logs?: BenchLogEntry[];
    // Dashboard lifecycle state (header pill + bottom bar)
    status?: BenchDashboardStatus;
    // Display prompt override; defaults to the first report's configured prompt
    prompt?: string;
    // External runner override — when set, the Scenario Execution header's
    // New Run dispatches here instead of creating in-dash benchmark entries
    onNewRun?: () => void;
    // The UNINVOKED MODEL plugin factories this instance loads (the bench
    // fleet). Defaults to the offline fallback fleet in dashboard/plugins
    // (PLUGINS). Callers discover the fleet at runtime (e.g.
    // fetchProviderModels → catalogToPluginFactories) and pass it here; a
    // prop change reloads the fleet, but identity-stable lists are expected
    // (memoized callers).
    pluginFactories?: BenchPluginFactory[];
    // The UNINVOKED SCENARIO plugin factories this instance loads (the
    // execution header's dropdown). Defaults to the offline default set in
    // dashboard/scenarios (SCENARIOS) — standalone, removable, swappable.
    scenarioFactories?: BenchScenarioFactory[];
};

/**
 * The @agentic/bench dashboard: a plugin-framework host rendering a fleet of
 * model plugins — multi-select on the rail, one shared Scenario Execution
 * header, and one column per selected model benchmarked by each New Run.
 */
export const BenchDashboard = React.memo((props: BenchDashboardProps) => {
    const { reports, entries, logs, status, prompt, onNewRun, pluginFactories, scenarioFactories } = props;

    const reportList = reports ?? [];
    // The fleet: injected factories win, else the offline fallback fleet.
    const fleet = pluginFactories ?? PLUGINS;
    // The scenarios: injected factories win, else the default scenario set.
    const scenarioSet = scenarioFactories ?? SCENARIOS;

    // Merge the injected props into the shared context store.
    // NOTE: the provider's data object is captured once at mount — in-dash
    // mutations (selection, live logs, benchmark entries) live on the shared
    // store object, while NEW props pushed by callers arrive as updates.
    const contextData = {
        reports: reportList,
        entries: entries ?? [],
        status: status ?? (reportList.length > 0 ? 'done' : 'idle'),
        // Display prompt: explicit prop wins, else the first report's prompt
        prompt: prompt ?? reportList[0]?.config.prompt ?? '',
        logs: logs ?? [],
        onNewRun: onNewRun ?? (() => {})
    };

    return (
        <DashboardShell>
            {/* One reactive context scope for the entire dashboard */}
            <BenchContextProvider data={contextData}>
                {/* Framework body — must render INSIDE the provider so hosts
                    and plugins can subscribe to the shared store */}
                <BenchDashboardBody
                    fleet={fleet}
                    scenarioSet={scenarioSet}
                    onNewRun={onNewRun}
                />
            </BenchContextProvider>
        </DashboardShell>
    );
});

// ── The framework body ───────────────────────────────────────────────────────
// Splits out of the shell so it renders inside BenchContextProvider (the
// store hooks are render-only, exactly like the maths dashboard's
// MathsDashboardBody pattern).
function BenchDashboardBody({
    fleet,
    scenarioSet,
    onNewRun
}: {
    fleet: BenchPluginFactory[];
    scenarioSet: BenchScenarioFactory[];
    onNewRun?: () => void;
}) {
    // THEME SYNC: applies the palette for the current mode (default 'system'
    // — follows the OS) and live-follows OS changes while in system mode.
    useBenchThemeSync();

    // PLUGIN LOADING ORDER — the dashboard loads FIRST, its plugins SECOND.
    // `fleet` holds the model factories UNINVOKED; useBenchPluginLoader
    // renders the shell with the FIRST plugin immediately, then loads the
    // remaining plugins ONE BY ONE after mount (framework/loader.ts).
    const { plugins: loadedPlugins, done: pluginsDone } = useBenchPluginLoader(fleet, BENCH_FRAMEWORK);

    // The scenario family loads through the SAME progressive mechanism —
    // its own loader instance feeding the execution header's dropdown (and
    // the columns' context, injected by the hosts below).
    const { plugins: loadedScenarios } = useBenchPluginLoader(scenarioSet, BENCH_FRAMEWORK);

    // Registry hook: reconciles the model selection (multi-select; default-
    // once fallback to the first registered plugin while the operator has
    // not toggled anything) and hands back the ordered plugin list.
    const { plugins } = useBenchPluginRegistry(loadedPlugins);

    return (
        <>
            {/* Top app bar: brand, lifecycle pill, theme control (run
                controls live in the Scenario Execution header) */}
            <SectionHeader />

            {/* Main split: model rail (multi-select) | execution header +
                model columns (run controls + dispatch + parallel benchmark
                entries, one column per selected model) */}
            <MainBand>
                <RailColumn>
                    {/* Every loaded model plugin's entries in registration
                        order; the rail grows as each plugin lands. Clicks
                        TOGGLE a model's selection (multi-select). */}
                    <BenchPluginRailHost plugins={plugins} />
                </RailColumn>

                <PluginColumn>
                    {/* Execution header: the scenario dropdown + plan
                        selects + New Run, SEPARATED from the models. One
                        click dispatches across every selected model ×
                        ticked scenario × concurrency lane. */}
                    <BenchScenarioExecutionHost plugins={plugins} scenarios={loadedScenarios} onRun={onNewRun} />
                    {/* Content area: one column per SELECTED model — this IS
                        each plugin's rendering contribution. Adding models
                        adds columns; the row squishes rather than wraps. */}
                    <BenchPluginColumnsHost plugins={plugins} scenarios={loadedScenarios} onRun={onNewRun} />
                    {/* Progressive loading hint while factories are pending. */}
                    {!pluginsDone ? <RailLoadingHint>{'Loading bench tests…'}</RailLoadingHint> : null}
                </PluginColumn>
            </MainBand>

            {/* Status footer: prompt + fleet roll-up + running-entries chip */}
            <BottomBar />
        </>
    );
}

// Progressive-load hint: shown under the model columns while the remaining
// plugin factories are still being loaded one by one (framework/loader.ts).
const RailLoadingHint = styledComponent('span', {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont,
    flexShrink: 0
});

// Pre-wired convenience export: storybook/tests can call benchDashboard({...})
// the way other packages ship prototypeComponent-wrapped defaults.
export const benchDashboard = prototypeComponent(BenchDashboard, {
    // Empty-but-valid defaults → the dashboard renders its quiet empty state
    reports: [],
    entries: [],
    logs: [],
    status: 'idle' as BenchDashboardStatus
});
