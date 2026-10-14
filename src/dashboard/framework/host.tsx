// dashboard/framework/host.tsx — plugin HOST components (framework-side
// mounting surfaces).
//
// Every bench plugin automatically gets access to these slots once
// registered (see plugins/index.ts and registry.ts):
//
//   <BenchPluginRailHost>        — renders every loaded plugin's entries in
//                                  registration order, wrapped in shared
//                                  list-button chrome (icon chip + label +
//                                  selected state). Clicking an entry
//                                  TOGGLES the owning plugin's selection
//                                  (multi-select — several models can be
//                                  benched in one go).
//   <BenchPluginToolbarHost>     — renders the first selected plugin's
//                                  toolbar (display/debug surface).
//   <BenchScenarioExecutionHost> — the "Scenario Execution" header: the
//                                  scenario dropdown + plan selects + New
//                                  Run, plus the dispatch that fans ONE
//                                  click out into every selected model ×
//                                  every ticked scenario × every lane.
//   <BenchPluginColumnsHost>     — one column per SELECTED plugin: each
//                                  selected model's panel renders side by
//                                  side (adding models adds columns; the
//                                  columns squish rather than wrap).
//
// All hosts subscribe to the shared store (useBenchDashboard), so selection
// changes and plugin mutations re-render exactly the hosts that care.
// Plugins NEVER import these — the framework host (BenchDashboard) does.
// This keeps the dependency direction one-way:
// framework → plugin contract ← plugin.
import React from 'react';
import { styledComponent } from '@presource/react';
import { createHttpProvider, DEFAULT_PROVIDER_URL } from '../../core';
import { useBenchDashboard } from '../context';
import { benchTheme } from '../utilities';
import { RunBar } from '../components';
import { launchScenario } from './scenario-kit';
import type { BenchPlugin, BenchScenarioPlugin } from './types';

// Shared props for the slot hosts: the ordered plugin list from the registry
// plus the framework-injected run plumbing (loaded scenarios + external
// runner override) that flows into the execution host.
export type BenchPluginHostProps = {
    plugins: BenchPlugin[];
    // The loaded scenario plugins — the execution host renders their specs
    // in the RunBar dropdown and dispatches their execute() on New Run.
    scenarios?: BenchScenarioPlugin[];
    // EXTERNAL RUNNER override (the dashboard's onNewRun prop) — when set,
    // New Run dispatches there instead of creating in-dash benchmark entries.
    onRun?: () => void;
};

// ── Rail host ─────────────────────────────────────────────────────────────────
// The unified left rail. Every loaded plugin contributes its entries here;
// entries keep a stable key of `${pluginId}:${entryId}` so React can track
// them even when plugins come and go. Plugins arrive ONE BY ONE (see
// loader.ts) — the rail grows as each lands.

// Rail button chrome shared by ALL plugins — the visual consistency layer
// (icon chip + label, indigo-tinted fill when selected).
const RailButton = styledComponent<{ active: string }>('button', {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    flexShrink: 0,
    width: '100%',
    border: ({ active }) => (active === 'true' ? `1px solid ${benchTheme.accent}` : `1px solid ${benchTheme.border}`),
    borderRadius: 10,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: ({ active }) => (active === 'true' ? 600 : 500),
    textAlign: 'left',
    whiteSpace: 'nowrap',
    // selected rows get the accent tint — passed as a string so nothing
    // leaks into the DOM and no boolean attribute warning fires
    background: ({ active }) => (active === 'true' ? benchTheme.accentSoft : benchTheme.surface),
    color: ({ active }) => (active === 'true' ? benchTheme.accentInk : benchTheme.textSecondary),
    fontFamily: benchTheme.sansFont,
    transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
    overflow: 'hidden'
});

const RailIcon = styledComponent<{ active: string }>('span', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    flexShrink: 0,
    borderRadius: 8,
    fontSize: 13,
    userSelect: 'none',
    background: ({ active }) => (active === 'true' ? benchTheme.accent : benchTheme.accentSoft),
    color: ({ active }) => (active === 'true' ? benchTheme.onAccent : benchTheme.accentInk)
});

const RailLabel = styledComponent('span', {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis'
});

// Rail frame heading (mirrors the maths dashboard's SidebarHeading role)
export const RailHeading = styledComponent('h2', {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: benchTheme.textMuted,
    margin: '0 0 6px 0',
    fontFamily: benchTheme.sansFont,
    flexShrink: 0,
    width: '100%'
});

/** The unified plugin rail: every loaded plugin's entries, in order. Clicks
 * TOGGLE the owning plugin's selection (multi-select — every selected model
 * gets a column and is benchmarked by one New Run). */
export function BenchPluginRailHost({ plugins }: BenchPluginHostProps) {
    const bench = useBenchDashboard();
    const selectedIds = bench.selectedPluginIds ?? [];

    // Flat, ordered list of (plugin, entry) pairs across ALL plugins — this
    // IS the dashboard's list of bench tests. Registration order = UI order.
    const items = plugins.flatMap((plugin) => plugin.entries.map((entry) => ({ plugin, entry })));

    if (items.length === 0) return null;

    return (
        <>
            <RailHeading>{'Bench Tests'}</RailHeading>
            {items.map(({ plugin, entry }) => {
                const active = selectedIds.includes(plugin.id);
                return (
                    <RailButton
                        key={`${plugin.id}:${entry.id}`}
                        active={active ? 'true' : 'false'}
                        aria-label={entry.ariaLabel ?? entry.label}
                        aria-pressed={active}
                        // Rail click TOGGLES the plugin's selection (multi-
                        // select). MUST go through the togglePlugin action —
                        // `bench` here is the useBenchDashboard() wrapper
                        // (snapshot reads only), so a direct
                        // `bench.selectedPluginIds = ...` write would land on
                        // the wrapper and never reach the store proxy /
                        // trigger a refresh.
                        onClick={() => {
                            bench.togglePlugin(plugin.id);
                        }}
                    >
                        <RailIcon active={active ? 'true' : 'false'} aria-hidden="true">
                            {entry.icon ?? '·'}
                        </RailIcon>
                        <RailLabel>{entry.label}</RailLabel>
                    </RailButton>
                );
            })}
        </>
    );
}

// ── Toolbar host ──────────────────────────────────────────────────────────────
export function BenchPluginToolbarHost({ plugins }: BenchPluginHostProps) {
    const bench = useBenchDashboard();
    // First selected plugin (display surface — the columns area renders the
    // whole selection).
    const firstId = (bench.selectedPluginIds ?? [])[0] ?? '';
    const active = plugins.find((p) => p.id === firstId) ?? plugins[0];
    if (!active?.toolbar) return null;
    const Toolbar = active.toolbar;
    return (
        <Toolbar
            context={{
                pluginId: active.id,
                entryId: active.entries[0]?.id ?? '',
                entries: active.entries
            }}
        />
    );
}

// ── Scenario execution host ──────────────────────────────────────────────────
// The "Scenario Execution" header, SEPARATED from the models: the scenario
// dropdown + plan selects + New Run sit ONCE above the model columns, and one
// New Run click fans out across EVERY selected model (a column each) × every
// ticked scenario × every concurrency lane — all launched in parallel.
//
//   [ Scenario Execution                [▾ scenarios][iters][conc][New Run] ]
//   <ticked scenario description + prompt>
//
// The dispatch reads each selected plugin's own binding (entry model +
// endpoint) unless the operator edited that column's target fields (store
// targets override — models/endpoints OUTSIDE the catalog stay benchmarkable).

// The execution block: header row + description line, stacked
const ExecutionBlock = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    width: '100%',
    minWidth: 0
});

// Header row: the section heading on the left, the run controls on the right
const ExecutionHeader = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
    width: '100%',
    minWidth: 0
});

// Section heading — the execution is now its own labelled area (it no longer
// lives inside one model's panel)
const ExecutionHeading = styledComponent('h3', {
    margin: 0,
    fontSize: 15,
    fontWeight: 700,
    color: benchTheme.textPrimary,
    fontFamily: benchTheme.sansFont,
    letterSpacing: '-0.01em',
    flexShrink: 0
});

// Description block under the run controls (what the ticked scenario does +
// the exact prompt it will send)
const ExecutionDescription = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0
});

const ExecutionDescriptionText = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont
});

const ExecutionPrompt = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.textSecondary,
    fontFamily: benchTheme.monoFont,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    minWidth: 0
});

/** The "Scenario Execution" header: run controls + the multi-model dispatch. */
export function BenchScenarioExecutionHost({ plugins, scenarios, onRun }: BenchPluginHostProps) {
    const bench = useBenchDashboard();
    const selectedIds = bench.selectedPluginIds ?? [];
    const scenarioPlugins = scenarios ?? [];
    const scenarioSpecs = scenarioPlugins.map((scenario) => scenario.spec);

    // The ticked scenarios (fallback: the first loaded one) — one entry each
    // per selected model per Run click, all launched in parallel. The same
    // queue drives the description line below.
    const ticked = scenarioPlugins.filter((scenario) => (bench.selectedScenarioIds ?? []).includes(scenario.id));
    const queue = ticked.length > 0 ? ticked : scenarioPlugins.slice(0, 1);
    const primary = queue[0];

    // THE DISPATCH — one click runs EVERY selected model. Semantics per
    // model (load-test style, mirrors k6 vus × iterations):
    //   iterations  = runs per bench entry (sequential within the entry)
    //   concurrency = how many bench entries generate side-by-side (LANES)
    // Total = models × scenarios × lanes. Each lane gets its OWN provider
    // instance + its OWN cancel control, and carries a lane tag in its
    // caption so parallel benches tell each other apart.
    const handleRun = (plan: { iterations: number; concurrency: number }) => {
        // External runner integration wins (the host's onNewRun prop)
        if (onRun) {
            onRun();
            return;
        }
        const selected = plugins.filter((plugin) => selectedIds.includes(plugin.id));
        if (selected.length === 0) {
            bench.pushLog('no models selected — tick models in Bench Tests', 'error');
            return;
        }
        if (queue.length === 0) {
            bench.pushLog('no benchmark scenarios installed', 'error');
            return;
        }
        // Sanitized lane count (the RunBar clamps already; the engine
        // re-sanitizes per entry too — belt and braces)
        const lanes = Math.max(1, Math.floor(plan.concurrency) || 1);
        selected.forEach((plugin) => {
            if (!plugin.createProvider) {
                bench.pushLog(`model ${plugin.entries[0]?.label ?? plugin.id} has no provider binding`, 'error');
                return;
            }
            // THIS plugin's own binding — the column's autofill default.
            const binding = plugin.entries[0];
            const specModel = binding?.model ?? plugin.id;
            const specEndpoint = binding?.endpoint ?? DEFAULT_PROVIDER_URL;
            // THE TARGET: the column's editable fields (store-backed per
            // plugin id). Blank/absent falls back to the plugin's own
            // binding.
            const override = bench.targets[plugin.id];
            const targetModel = override?.model?.trim() || specModel;
            const targetEndpoint = override?.endpoint?.trim() || specEndpoint;
            // UNTOUCHED column (no stored override, or one equal to the
            // plugin's own binding) → the plugin's own provider factory —
            // the demo/stub transport injection (dashboard/plugins/index.ts
            // demoFleets, stories/tests) keeps working. Any edit → a live
            // HTTP provider built from the typed model id + endpoint
            // (core/provider.ts).
            const untouched = targetModel === specModel && targetEndpoint === specEndpoint;
            const buildProvider = untouched
                ? plugin.createProvider
                : () => createHttpProvider(targetModel, { baseUrl: targetEndpoint });
            // Parallel launch: every ticked scenario × every lane gets its
            // OWN entry + provider instance, none awaiting another. Within a
            // lane the iterations run sequentially (per-entry concurrency 1)
            // so lanes ARE the parallelism — one visible bench card each.
            queue.forEach((scenario) => {
                for (let lane = 0; lane < lanes; lane += 1) {
                    void launchScenario({
                        scenario,
                        // Entry grouping stays on the PLUGIN's model id (the
                        // entries render in this model's column); the actual
                        // target model/endpoint live in the provider + report.
                        modelId: plugin.id,
                        modelLabel: binding?.label ?? plugin.id,
                        provider: buildProvider(),
                        actions: bench,
                        plan: { ...plan, concurrency: 1 },
                        // Lane tag only when there IS more than one lane —
                        // single-lane runs keep the clean scenario caption
                        entryLabel: lanes > 1 ? `${scenario.spec.label} · lane ${lane + 1}` : undefined
                    });
                }
            });
        });
    };

    return (
        <ExecutionBlock>
            <ExecutionHeader>
                <ExecutionHeading data-testid="bench-execution-heading">{'Scenario Execution'}</ExecutionHeading>
                <RunBar scenarios={scenarioSpecs} onRun={handleRun} />
            </ExecutionHeader>

            {/* DESCRIPTION: what the ticked scenario does + the exact prompt
                it will send — execution detail now that the controls are
                separated from the model columns */}
            {primary ? (
                <ExecutionDescription>
                    {primary.spec.description ? <ExecutionDescriptionText>{primary.spec.description}</ExecutionDescriptionText> : null}
                    <ExecutionPrompt title={primary.spec.prompt}>{primary.spec.prompt}</ExecutionPrompt>
                </ExecutionDescription>
            ) : null}
        </ExecutionBlock>
    );
}

// ── Columns host ──────────────────────────────────────────────────────────────
// One column per SELECTED plugin: each selected model's panel renders side by
// side. The row NEVER wraps — columns squish (min-width: 0) instead, and new
// selections simply add columns.
//
// The columns row itself is layout-only: each panel owns its content (title,
// target fields, benchmark entries). The eager `plugins[0]` fallback mirrors
// the registry's default-once semantics so the first frame (before the
// registry's layout effect fires) never flashes an empty row on a fresh
// dashboard — but a deliberate operator deselect-all (touched) IS respected.

// The columns row: flex line of model columns, squishing rather than wrapping
const ColumnsRow = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 14,
    width: '100%',
    minWidth: 0
});

// Empty-selection hint (operator deselected every model): a quiet block where
// the columns would be
const ColumnsHint = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    padding: '40px 20px',
    width: '100%',
    border: `1px dashed ${benchTheme.border}`,
    borderRadius: benchTheme.radius,
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont
});

const ColumnsHintTitle = styledComponent('span', {
    fontSize: 13,
    fontWeight: 600,
    color: benchTheme.textSecondary
});

const ColumnsHintText = styledComponent('span', {
    fontSize: 12
});

/** One column per selected model; new selections add columns, never wrap. */
export function BenchPluginColumnsHost({ plugins, scenarios, onRun }: BenchPluginHostProps) {
    const bench = useBenchDashboard();
    const selectedIds = bench.selectedPluginIds ?? [];
    const selected = selectedIds
        .map((id) => plugins.find((plugin) => plugin.id === id))
        .filter((plugin): plugin is BenchPlugin => Boolean(plugin));

    // Eager default: fresh dashboard (selection untouched) shows the first
    // plugin's column even on the first frame; a deliberate deselect-all
    // shows the empty hint instead.
    const columns =
        selected.length > 0
            ? selected
            : !bench.modelSelectionTouched && plugins.length > 0
                ? plugins.slice(0, 1)
                : [];

    if (columns.length === 0) {
        return (
            <ColumnsHint data-testid="bench-columns-empty">
                <ColumnsHintTitle>{'No models selected'}</ColumnsHintTitle>
                <ColumnsHintText>{'Tick models in Bench Tests — one column each, all benched by New Run.'}</ColumnsHintText>
            </ColumnsHint>
        );
    }

    return (
        <ColumnsRow>
            {columns.map((plugin) => {
                const Panel = plugin.panel;
                return (
                    <Panel
                        key={plugin.id}
                        context={{
                            pluginId: plugin.id,
                            entryId: plugin.entries[0]?.id ?? '',
                            entries: plugin.entries,
                            scenarios,
                            onRun
                        }}
                    />
                );
            })}
        </ColumnsRow>
    );
}
