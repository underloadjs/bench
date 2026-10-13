// dashboard/BenchDashboard.tsx — the @agentic/bench dashboard orchestrator.
//
// The dashboard is a FRAMEWORK HOST (mirrors
// distribution/maths/src/components/MathsDashboard.tsx). It contains no bench
// logic of its own — the bench tests live in TWO plugin families, both loaded
// from the framework:
//
//   MODEL plugins    dashboard/plugins/    → the rail (one entry per model)
//   SCENARIO plugins dashboard/scenarios/  → the model panel's dropdown (one
//                                           entry per benchmark scenario;
//                                           several can be ticked and
//                                           benchmarked TOGETHER)
//
//   plugins/index.ts      → the ordered list of UNINVOKED model factories
//   scenarios/index.ts    → the ordered list of UNINVOKED scenario factories
//   framework/loader      → loads both families one by one after the shell
//                           renders
//   framework/registry    → reconciles the ACTIVE model selection
//   framework/host        → mounts rail entries + the panel slot (injecting
//                           the loaded scenarios + external runner override
//                           into the panel's context)
//   framework/types       → the plugin + scenario contracts
//   framework/scenario-kit→ compiles helpers + launches benchmark entries
//
// THE RUN FLOW: the run controls (scenario dropdown + plan selects + New
// Run) live INSIDE the active model's panel, directly under the model name.
// Each click creates a NEW benchmark entry per ticked scenario (store
// addEntry) and launches them IN PARALLEL — every entry updates
// progressively (per-run progress + partial reports) via its compiled
// helper (framework/scenario-kit.ts).
//
// Visual layout (clean, card-based — design tokens in
// dashboard/utilities/theme.ts). Models are benchmarked INDIVIDUALLY, so
// there is deliberately NO cross-model comparison surface (the former fleet
// stats strip was removed):
//
// ┌────────────────────────────────────────────────────────────────────────┐
// │ B  Bench / MODEL BENCHMARK                        [theme] [● IDLE]     │
// ├────────────────────────────────────────────────────────────────────────┤
// │ ┌──────────────┐ ┌──────────────────────────────────────────────────┐  │
// │ │ PLUGIN RAIL   │ │ <model name>                     [model panel] │  │
// │ │ (models)      │ │ [scenario ▾][iters ▾][conc ▾][New Run]        │  │
// │ │               │ │ <description + prompt>                        │  │
// │ │               │ │ ───────────────────────────────────────       │  │
// │ │               │ │ <benchmark entry — newest first>              │  │
// │ │               │ │ <benchmark entry>                             │  │
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
    BenchPluginPanelHost,
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

// The main content band: rail | model panel (the former right column —
// leaderboard / timeline / console — and the fleet stats strip were removed;
// models are benchmarked individually, entries live in the model panel).
// Generous padding keeps the content card clear of the header/rail/footer.
const MainBand = styledComponent('main', {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'row',
    gap: 20,
    padding: '20px 28px 24px 28px',
    overflow: 'hidden'
});

// Plugin rail column: the model list (grows as plugins load one by one)
const RailColumn = styledComponent('div', {
    flex: '0 0 220px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
    overflowY: 'auto'
});

// Center column: the ACTIVE model's panel (scrollable)
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
    // External runner override — when set, the panel's New Run dispatches
    // here instead of creating in-dash benchmark entries
    onNewRun?: () => void;
    // The UNINVOKED MODEL plugin factories this instance loads (the bench
    // fleet). Defaults to the offline fallback fleet in dashboard/plugins
    // (PLUGINS). Callers discover the fleet at runtime (e.g.
    // fetchProviderModels → catalogToPluginFactories) and pass it here; a
    // prop change reloads the fleet, but identity-stable lists are expected
    // (memoized callers).
    pluginFactories?: BenchPluginFactory[];
    // The UNINVOKED SCENARIO plugin factories this instance loads (the model
    // panel's dropdown). Defaults to the offline default set in
    // dashboard/scenarios (SCENARIOS) — standalone, removable, swappable.
    scenarioFactories?: BenchScenarioFactory[];
};

/**
 * The @agentic/bench dashboard: a plugin-framework host rendering a fleet of
 * model plugins, each with its own scenario dropdown, run controls and
 * parallel benchmark entries.
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
    // its own loader instance feeding the model panels' dropdowns (injected
    // into each panel's context by the panel host below).
    const { plugins: loadedScenarios } = useBenchPluginLoader(scenarioSet, BENCH_FRAMEWORK);

    // Registry hook: reconciles the ACTIVE MODEL selection (falling back to
    // the first registered plugin when the selection is stale or empty) and
    // hands back the ordered plugin list.
    const { plugins } = useBenchPluginRegistry(loadedPlugins);

    return (
        <>
            {/* Top app bar: brand, lifecycle pill, theme control (run
                controls live inside the model panel, under the model name) */}
            <SectionHeader />

            {/* Main split: model rail | active model's panel (run controls +
                description + parallel benchmark entries) */}
            <MainBand>
                <RailColumn>
                    {/* Every loaded model plugin's entries in registration
                        order; the rail grows as each plugin lands. */}
                    <BenchPluginRailHost plugins={plugins} />
                </RailColumn>

                <PluginColumn>
                    {/* Content area: the ACTIVE model's panel slot — this IS
                        the plugin's rendering contribution. The host injects
                        the loaded scenarios + the external runner override
                        into the panel's context. */}
                    <BenchPluginPanelHost plugins={plugins} scenarios={loadedScenarios} onRun={onNewRun} />
                    {/* Progressive loading hint while factories are pending. */}
                    {!pluginsDone ? <RailLoadingHint>{'Loading bench tests…'}</RailLoadingHint> : null}
                </PluginColumn>
            </MainBand>

            {/* Status footer: prompt + fleet roll-up + running-entries chip */}
            <BottomBar />
        </>
    );
}

// Progressive-load hint: shown under the active panel while the remaining
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
