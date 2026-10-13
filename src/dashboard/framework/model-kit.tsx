// dashboard/framework/model-kit.tsx — the framework's standard model-bench recipe.
//
// `createModelBench(spec)` builds a COMPLETE per-model BenchPlugin from a
// ModelBenchSpec — this is what a model-bench plugin's factory function
// calls with the BenchFramework it receives from the dashboard (mirrors
// distribution/maths/src/framework/worksheet-kit.tsx).
//
// THE PANEL IS THE MODEL PAGE — everything for one model lives in ONE card:
//
//   <model name>
//   [scenario ▾] [iterations ▾] [concurrency ▾] [New Run]   ← run controls
//   <scenario description + prompt>                         ← description
//   ────────────────────────────────────────────────
//   <benchmark entry — newest first>                        ← run history
//   <benchmark entry>
//
// Each New Run click creates NEW benchmark entries (framework/scenario-kit.ts
// launchScenario) — one per ticked scenario PER CONCURRENCY LANE — and entries
// run IN PARALLEL with each other: the Concurrency select fans out into that
// many side-by-side bench cards (lanes), the Iterations select sets the runs
// each lane executes sequentially. Every entry updates progressively
// (progress counter + partial report per settled run).
//
// Models are benchmarked INDIVIDUALLY — there is deliberately no cross-model
// comparison surface (the old fleet stats strip was removed). The plugin's
// execution contribution is `createProvider`: the panel builds the provider
// and the framework compiles it into each scenario's helper.
//
// STATE: the plugin keeps NO state of its own. Entries live in the SHARED
// framework store (dashboard/context/store.ts addEntry/updateEntry); the
// compiled scenario helper writes progress + reports into its entry, so the
// panel re-renders live with zero plugin-framework coupling.
import React from 'react';
import { styledComponent } from '@presource/react';
import { createHttpProvider, DEFAULT_PROVIDER_URL } from '../../core';
import {
    defineBenchPlugin,
    type BenchPlugin,
    type BenchPluginContext,
    type BenchScenarioPlugin,
    type ModelBenchSpec
} from './types';
import type { BenchScenarioSpec } from './types';
import { launchScenario } from './scenario-kit';
import { useBenchDashboard, type BenchEntry } from '../context';
import { benchTheme, formatCount, formatPercent, formatSeconds, formatTokensPerSec } from '../utilities';
import { Card, RunBar } from '../components';

// ── Panel surface (the content area) ─────────────────────────────────────────
// The model page: run controls under the model name, the ticked scenario's
// description + prompt beneath, then the accumulated benchmark entries
// (newest first, parallel, progressively updated).
const createPanel = (spec: ModelBenchSpec) => {
    const ModelBenchPanel = ({ context }: { context: BenchPluginContext }) => {
        // Live shared store — every entry write re-renders this panel
        const bench = useBenchDashboard();
        // THIS model's benchmark entries (the panel is the model page)
        const entries = bench.entries.filter((entry) => entry.model === spec.id);
        // Loaded scenario plugins from the host-injected context
        const scenarios: BenchScenarioPlugin[] = context.scenarios ?? [];
        const scenarioSpecs: BenchScenarioSpec[] = scenarios.map((scenario) => scenario.spec);

        // The ticked scenarios (fallback: the first loaded one) — one entry
        // each per Run click, all launched in parallel
        const ticked = scenarios.filter((scenario) => bench.selectedScenarioIds.includes(scenario.id));
        const queue = ticked.length > 0 ? ticked : scenarios.slice(0, 1);
        // The description line shows the primary scenario's description+prompt
        const primary = queue[0];

        // ── THE BENCHMARK TARGET ────────────────────────────────────────
        // The two EDITABLE fields every New Run executes against. The rail
        // menu is their autofill source (activation snaps them to THIS
        // model's binding below), but both stay freely editable so models
        // and endpoints OUTSIDE the loaded catalog can be benchmarked.
        // RESOLVED endpoint of this panel's own model (spec.baseUrl is
        // pre-resolved at factory time — dashboard/plugins/model-bench.ts).
        const specEndpoint = spec.baseUrl ?? DEFAULT_PROVIDER_URL;
        // LOCAL DRAFTS: the inputs are controlled by local state, NOT the
        // store. Reason (localContextStore internals,
        // presource/react/src/context/local.tsx:61-65): store writes trigger
        // a DEFERRED setTimeout refresh, so a store-backed input would be
        // clobbered mid-typing by any other store write re-rendering the
        // panel (e.g. live entry updates while a bench runs). Drafts
        // initialize from THIS panel's own binding and write through on
        // every keystroke so handleRun + tests can read the target from
        // the store too.
        const [modelDraft, setModelDraft] = React.useState(spec.id);
        const [endpointDraft, setEndpointDraft] = React.useState(specEndpoint);

        // ACTIVATION AUTOFILL — "clicking on the left updates the two
        // fields": whenever THIS panel's model becomes active (mount after
        // a rail switch, or the registry's first-plugin fallback) both
        // target fields snap to the model's own binding.
        React.useEffect(() => {
            bench.applyTarget(spec.id, specEndpoint);
            setModelDraft(spec.id);
            setEndpointDraft(specEndpoint);
            // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync only when THIS panel's model changes
        }, [spec.id]);

        // EXTERNAL AUTOFILL SYNC: a rail (re)click of an ALREADY-active
        // model re-applies the binding through the store (framework/host.tsx)
        // without remounting this panel — mirror it into the drafts so the
        // visible fields follow the rail like they do on activation. User
        // keystrokes also land here (write-through) — resetting a draft to
        // the value it already holds is a no-op re-render.
        React.useEffect(() => {
            if (bench.targetModel) setModelDraft(bench.targetModel);
            if (bench.targetEndpoint) setEndpointDraft(bench.targetEndpoint);
        }, [bench.targetModel, bench.targetEndpoint]);

        // THE DISPATCH — the concurrency setting FANS OUT into PARALLEL BENCH
        // ENTRIES (lanes). This is the operator-visible meaning of the
        // Concurrency select: concurrency 3 + New Run → THREE benchmark
        // entries appear on the panel and generate SIMULTANEOUSLY (the
        // reported bug: the old dispatch created ONE entry and applied the
        // concurrency inside it, so with iterations 1 only a single bench —
        // a single run — ever showed up).
        //
        // Semantics (load-test style, mirrors k6 vus × iterations):
        //   iterations  = runs per bench entry (sequential within the entry)
        //   concurrency = how many bench entries generate side-by-side
        // Total requests = iterations × concurrency. Each lane gets its OWN
        // provider instance + its OWN cancel control (the entry card's
        // CANCEL button aborts just that lane), and carries a lane tag in
        // its caption so the parallel benches tell each other apart.
        const handleRun = (plan: { iterations: number; concurrency: number }) => {
            // External runner integration wins (the host's onNewRun prop)
            if (context.onRun) {
                context.onRun();
                return;
            }
            if (queue.length === 0) {
                bench.pushLog('no benchmark scenarios installed', 'error');
                return;
            }
            if (!spec.createProvider) {
                bench.pushLog(`model ${spec.label ?? spec.id} has no provider binding`, 'error');
                return;
            }
            // Sanitized lane count (the RunBar clamps already; the engine
            // re-sanitizes per entry too — belt and braces)
            const lanes = Math.max(1, Math.floor(plan.concurrency) || 1);
            // THE TARGET: the two editable fields (autofilled by the rail,
            // editable to test anything outside the catalog). Blank falls
            // back to this panel's own binding.
            const targetModel = modelDraft.trim() || spec.id;
            const targetEndpoint = endpointDraft.trim() || specEndpoint;
            // UNTOUCHED autofill (both fields still equal the plugin's own
            // binding) → the spec's own provider factory — the demo/stub
            // transport injection (dashboard/plugins/index.ts demoFleets,
            // stories/tests) keeps working. Any edit → a live HTTP provider
            // built from the typed model id + endpoint (core/provider.ts).
            const untouched = targetModel === spec.id && targetEndpoint === specEndpoint;
            const buildProvider = untouched
                ? spec.createProvider
                : () => createHttpProvider(targetModel, { baseUrl: targetEndpoint });
            // Parallel launch: every ticked scenario × every lane gets its
            // OWN entry + provider instance, none awaiting another. Within a
            // lane the iterations run sequentially (per-entry concurrency 1)
            // so lanes ARE the parallelism — one visible bench card each.
            queue.forEach((scenario) => {
                for (let lane = 0; lane < lanes; lane += 1) {
                    void launchScenario({
                        scenario,
                        // Entry grouping stays on the PANEL's model id (the
                        // entries render in this panel); the actual target
                        // model/endpoint live in the provider + report.
                        modelId: spec.id,
                        modelLabel: spec.label ?? spec.id,
                        provider: buildProvider(),
                        actions: bench,
                        plan: { ...plan, concurrency: 1 },
                        // Lane tag only when there IS more than one lane —
                        // single-lane runs keep the clean scenario caption
                        entryLabel: lanes > 1 ? `${scenario.spec.label} · lane ${lane + 1}` : undefined
                    });
                }
            });
        };

        return (
            <Card>
                {/* THE MODEL PAGE — one card per model, evenly spaced:
                    <model name> / <run controls, right-aligned> /
                    <description> / <benchmark entries> */}
                <PanelShell>
                    <PanelTitleRow>
                        {/* Title testid kept from the old toolbar card (App test
                            asserts the rail-click switch through it) */}
                        <PanelTitle data-testid="bench-toolbar-model">{spec.label ?? spec.id}</PanelTitle>
                        <PanelCount>
                            {`${entries.length} benchmark${entries.length === 1 ? '' : 's'}`}
                        </PanelCount>
                    </PanelTitleRow>

                    {/* THE TARGET FIELDS — editable model id + endpoint the
                        benchmark runs against. Autofilled from the rail
                        selection (activation + rail re-click), editable to
                        benchmark models/endpoints OUTSIDE the catalog. */}
                    <TargetRow>
                        <TargetModelField>
                            <TargetLabel>{'Model'}</TargetLabel>
                            <TargetInput
                                data-testid="bench-target-model"
                                type="text"
                                aria-label="Benchmark target model"
                                spellCheck={false}
                                value={modelDraft}
                                placeholder={spec.id}
                                onChange={(event) => {
                                    setModelDraft(event.target.value);
                                    bench.setTargetModel(event.target.value);
                                }}
                            />
                        </TargetModelField>
                        <TargetEndpointField>
                            <TargetLabel>{'Endpoint'}</TargetLabel>
                            <TargetInput
                                data-testid="bench-target-endpoint"
                                type="text"
                                aria-label="Benchmark target endpoint"
                                spellCheck={false}
                                value={endpointDraft}
                                placeholder={specEndpoint}
                                onChange={(event) => {
                                    setEndpointDraft(event.target.value);
                                    bench.setTargetEndpoint(event.target.value);
                                }}
                            />
                        </TargetEndpointField>
                    </TargetRow>

                    {/* RUN CONTROLS directly under the model name (right-aligned) */}
                    <RunBar scenarios={scenarioSpecs} onRun={handleRun} />

                    {/* DESCRIPTION: what the ticked scenario does + the exact
                        prompt it will send */}
                    {primary ? (
                        <PanelDescription>
                            {primary.spec.description ? <PanelDescriptionText>{primary.spec.description}</PanelDescriptionText> : null}
                            <PanelPrompt title={primary.spec.prompt}>{primary.spec.prompt}</PanelPrompt>
                        </PanelDescription>
                    ) : null}

                    {/* BENCHMARK ENTRIES — newest first (the store prepends).
                        Each click appends a new entry; entries run in parallel. */}
                    {entries.length > 0 ? (
                        <PanelEntries>
                            {entries.map((entry) => (
                                <EntryCard key={entry.id} entry={entry} />
                            ))}
                        </PanelEntries>
                    ) : (
                        <PanelEmpty>
                            <PanelEmptyIcon aria-hidden="true">{'⚡'}</PanelEmptyIcon>
                            <PanelEmptyTitle>{'Not benchmarked yet'}</PanelEmptyTitle>
                            <PanelEmptyHint>{'Pick scenarios and press New Run — each run adds an entry here.'}</PanelEmptyHint>
                        </PanelEmpty>
                    )}
                </PanelShell>
            </Card>
        );
    };
    return ModelBenchPanel;
};

// ── One benchmark entry ──────────────────────────────────────────────────────
// Header: scenario label + live counter + status chip. While running: the
// progress strip + one live "N tok received" row per IN-FLIGHT run. Once a
// report exists (partial OR final): the summary line + per-iteration rows —
// all updating progressively as runs settle.
const EntryCard = ({ entry }: { entry: BenchEntry }) => {
    const { report, progress } = entry;
    // LIVE STREAMING READOUTS: one per in-flight run (written by the compiled
    // scenario helper from the engine's onStream ticks). Sorted by run index
    // so the live rows render in stable order; only shown while the entry is
    // still running (each readout is removed the moment its run settles).
    const liveStreams = [...(entry.streaming ?? [])].sort((a, b) => a.index - b.index);
    // CANCEL-AFFORDANCE hover: while the entry runs, its status chip is a
    // button that reveals "CANCEL" on hover (the operator's eye is already
    // on the RUNNING chip — turning it into the control avoids adding
    // chrome). Hover is tracked in state so the label + palette swap without
    // CSS-selector support in styledComponent's flat input map.
    const [cancelHovered, setCancelHovered] = React.useState(false);
    // The live shared store — cancelEntry aborts THIS entry's controller
    const bench = useBenchDashboard();
    return (
        <EntryShell data-testid={`bench-entry-${entry.id}`}>
            <EntryHeader>
                <EntryScenario>{entry.scenarioLabel}</EntryScenario>
                {/* The header rate is the DECODE average (the prefill
                    average lives in its own tile below) */}
                <EntryMeta>
                    {`${progress.completed}/${progress.total} runs`}
                    {report ? ` · ${formatTokensPerSec(report.summary.throughput)} decode` : ''}
                    {report ? ` · ${formatSeconds(report.summary.wallTime)} wall` : ''}
                </EntryMeta>
                {/* Status chip: green DONE. While RUNNING it doubles as the
                    cancel control: reads "RUNNING" (amber), flips to a
                    clickable "CANCEL" (danger) on hover. */}
                {entry.status === 'running' ? (
                    <EntryCancelButton
                        hovered={cancelHovered ? 'true' : 'false'}
                        onMouseEnter={() => setCancelHovered(true)}
                        onMouseLeave={() => setCancelHovered(false)}
                        onClick={() => bench.cancelEntry(entry.id)}
                        aria-label={`Cancel ${entry.scenarioLabel} benchmark`}
                        data-testid={`bench-cancel-${entry.id}`}
                    >
                        {cancelHovered ? 'CANCEL' : 'RUNNING'}
                    </EntryCancelButton>
                ) : (
                    <EntryStatusChip status={entry.status}>{entry.status.toUpperCase()}</EntryStatusChip>
                )}
            </EntryHeader>

            {/* PROGRESSIVE FEEDBACK: live fill bar while the entry runs */}
            {entry.status === 'running' ? (
                <EntryProgressTrack>
                    <EntryProgressFill
                        width={`${progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0}%`}
                    />
                </EntryProgressTrack>
            ) : null}

            {/* LIVE STREAMING READOUTS: one row per IN-FLIGHT run — "N tok
                received · X tok/s" updating as chunks stream in (cleared per
                run the moment it settles). This is the ongoing detail the
                panel shows between "0/3 runs" and the settled run rows. */}
            {entry.status === 'running' && liveStreams.length > 0 ? (
                <EntryLive>
                    {liveStreams.map((stream) => (
                        <EntryLiveRow key={stream.index}>
                            <EntryRunLabel>{`run ${stream.index + 1}`}</EntryRunLabel>
                            <EntryLiveReadout>
                                {`${formatCount(stream.tokens)} tok received · ${stream.tokensPerSec.toFixed(1)} tok/s · ${formatSeconds(stream.elapsed)}`}
                            </EntryLiveReadout>
                        </EntryLiveRow>
                    ))}
                </EntryLive>
            ) : null}
            {progress.failed > 0 ? <EntryFailed>{`${progress.failed} failed`}</EntryFailed> : null}

            {/* Summary tiles + per-iteration rows once runs have settled.
                THE TWO SPEED METRICS get their own tiles: Prefill (input —
                promptTokens / ttft) and Decode (output — the summary's
                throughput mean). */}
            {report ? (
                <React.Fragment>
                    <EntryTiles>
                        <EntryTile>
                            <EntryTileLabel>{'Prefill'}</EntryTileLabel>
                            <EntryTileValue>{formatTokensPerSec(report.summary.avgPrefillTokensPerSec)}</EntryTileValue>
                        </EntryTile>
                        <EntryTile>
                            <EntryTileLabel>{'Decode'}</EntryTileLabel>
                            <EntryTileValue>{formatTokensPerSec(report.summary.throughput)}</EntryTileValue>
                        </EntryTile>
                        <EntryTile>
                            <EntryTileLabel>{'Avg TTFT'}</EntryTileLabel>
                            <EntryTileValue>{formatSeconds(report.summary.avgTtft)}</EntryTileValue>
                        </EntryTile>
                        <EntryTile>
                            <EntryTileLabel>{'Avg Time'}</EntryTileLabel>
                            <EntryTileValue>{formatSeconds(report.summary.avgTime)}</EntryTileValue>
                        </EntryTile>
                        <EntryTile>
                            <EntryTileLabel>{'Success'}</EntryTileLabel>
                            <EntryTileValue>{formatPercent(report.summary.successRate)}</EntryTileValue>
                        </EntryTile>
                    </EntryTiles>

                    <EntryRuns>
                        {report.runs.map((run) => (
                            <EntryRunRow key={run.index}>
                                <EntryRunLabel>{`run ${run.index + 1}`}</EntryRunLabel>
                                {run.error ? (
                                    <EntryRunFailed title={run.error}>{`failed: ${run.error}`}</EntryRunFailed>
                                ) : (
                                    <EntryRunReadout>
                                        {`${formatSeconds(run.totalTime)} · ${formatTokensPerSec(run.prefillTokensPerSec, 0)} prefill · ${run.tokensPerSec.toFixed(1)} tok/s decode · ${formatCount(run.totalTokens)} tok`}
                                    </EntryRunReadout>
                                )}
                            </EntryRunRow>
                        ))}
                    </EntryRuns>
                </React.Fragment>
            ) : null}
        </EntryShell>
    );
};

// ── Target fields (editable model + endpoint the runs execute against) ──────
// One row under the title: [Model ____] [Endpoint ____]. The rail autofills
// both; typing overrides the run target (framework/model-kit handleRun
// rebuilds the provider from these).

const TargetRow = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    width: '100%',
    minWidth: 0
});

const TargetField = styledComponent('label', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0
});

// Model id: compact (ids are short); endpoint gets the remaining width
const TargetModelField = styledComponent(TargetField, {
    flex: '1 1 220px'
});

const TargetEndpointField = styledComponent(TargetField, {
    flex: '2 1 320px'
});

const TargetLabel = styledComponent('span', {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont,
    flexShrink: 0
});

// styledComponent's typed surface lacks input props → cast (PlanInput
// pattern in components/modules/RunBar.tsx:181-195).
const TargetInput = styledComponent('input', {
    flex: 1,
    minWidth: 0,
    boxSizing: 'border-box',
    padding: '7px 10px',
    background: benchTheme.surface,
    border: `1px solid ${benchTheme.border}`,
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 500,
    fontFamily: benchTheme.monoFont,
    color: benchTheme.textPrimary,
    outline: 'none'
}) as unknown as React.ForwardRefExoticComponent<
    React.InputHTMLAttributes<HTMLInputElement> & { theme?: any; [breakpoint: string]: any }
>;

// ── The recipe ───────────────────────────────────────────────────────────────
// Assemble the full plugin from a model spec: one rail entry (the model),
// the model-page panel, and the provider factory the panel compiles into
// each scenario helper (the model's whole execution contribution).
export function createModelBench(spec: ModelBenchSpec): BenchPlugin {
    return defineBenchPlugin({
        id: spec.id,
        name: `${spec.label ?? spec.id} Bench`,
        // THE RAIL LABEL: one entry, the plugin's own model. The entry also
        // carries the TARGET AUTOFILL payload (model + endpoint) — a rail
        // click snaps the panel's two editable target fields to it
        // (framework/host.tsx → store applyTarget).
        entries: [
            {
                id: spec.id,
                label: spec.label ?? spec.id,
                icon: spec.icon,
                ariaLabel: `Benchmark ${spec.label ?? spec.id}`,
                model: spec.id,
                endpoint: spec.baseUrl ?? DEFAULT_PROVIDER_URL
            }
        ],
        panel: createPanel(spec),
        // The execution binding: the panel builds THIS model's provider
        // (HTTP transport bound to the catalog base URL, or an injected
        // demo/stub transport) per launch. Without it the model cannot be
        // benchmarked.
        createProvider: spec.createProvider
    });
}

// Re-exported for the framework barrel (framework.ts references it).
export { useBenchDashboard };

// ── Styled components (framework chrome, shared by all model benches) ───────

// Model-page shell: even vertical rhythm between title / run controls /
// description / entries (spacing comes from the gap — the card body's
// padding handles the outer breathing room)
const PanelShell = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    width: '100%',
    minWidth: 0
});

// Model-page title row (the card is header-less; the panel owns its title)
const PanelTitleRow = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 12,
    minWidth: 0
});

const PanelTitle = styledComponent('h3', {
    margin: 0,
    fontSize: 15,
    fontWeight: 700,
    color: benchTheme.textPrimary,
    fontFamily: benchTheme.sansFont,
    letterSpacing: '-0.01em',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
});

const PanelCount = styledComponent('span', {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont,
    flexShrink: 0
});

// Description block under the run controls
const PanelDescription = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0
});

const PanelDescriptionText = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont
});

const PanelPrompt = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.textSecondary,
    fontFamily: benchTheme.monoFont,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    minWidth: 0
});

// Benchmark entries list (newest first — the store prepends)
const PanelEntries = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    // Divider between the description block and the run history
    borderTop: `1px solid ${benchTheme.border}`,
    paddingTop: 14
});

// One entry: a soft inset card inside the model panel
const EntryShell = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '12px 14px',
    borderRadius: 10,
    background: benchTheme.surfaceFaint,
    border: `1px solid ${benchTheme.border}`
});

const EntryHeader = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minWidth: 0
});

const EntryScenario = styledComponent('span', {
    fontSize: 13,
    fontWeight: 700,
    color: benchTheme.textPrimary,
    fontFamily: benchTheme.sansFont,
    flexShrink: 0
});

const EntryMeta = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.textSecondary,
    fontFamily: benchTheme.monoFont,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    flex: 1,
    minWidth: 0
});

// Status chip: tinted per lifecycle (amber running / green done)
const EntryStatusChip = styledComponent<{ status: string }>('span', {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    padding: '3px 10px',
    borderRadius: 999,
    flexShrink: 0,
    fontFamily: benchTheme.sansFont,
    background: ({ status }) => (status === 'running' ? benchTheme.warningSoft : benchTheme.successSoft),
    color: ({ status }) => (status === 'running' ? benchTheme.warning : benchTheme.success)
});

// The RUNNING chip doubling as the cancel control: reads "RUNNING" (amber
// tint) at rest; on hover it flips to a clickable "CANCEL" (danger tint) —
// same geometry as the status chip so nothing shifts. Hover is passed as a
// string prop ('true'/'false' — nothing leaks into the DOM).
const EntryCancelButton = styledComponent<{ hovered: string }>('button', {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    padding: '3px 10px',
    borderRadius: 999,
    flexShrink: 0,
    fontFamily: benchTheme.sansFont,
    cursor: 'pointer',
    border: 'none',
    background: ({ hovered }) => (hovered === 'true' ? benchTheme.dangerSoft : benchTheme.warningSoft),
    color: ({ hovered }) => (hovered === 'true' ? benchTheme.danger : benchTheme.warning)
});

// Entry progress strip (visible while running)
const EntryProgressTrack = styledComponent('div', {
    height: 6,
    borderRadius: 999,
    background: benchTheme.track,
    overflow: 'hidden',
    width: '100%'
});

const EntryProgressFill = styledComponent<{ width: string }>('div', {
    height: '100%',
    borderRadius: 999,
    background: benchTheme.accent,
    transition: 'width 0.2s ease',
    width: 'custom'
});

const EntryFailed = styledComponent('span', {
    fontSize: 11,
    fontWeight: 600,
    color: benchTheme.danger,
    fontFamily: benchTheme.monoFont
});

// Live streaming readouts (in-flight runs only — the strip disappears once
// every run settled; same row geometry as the settled run rows below)
const EntryLive = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 2
});

const EntryLiveRow = styledComponent('div', {
    display: 'grid',
    gridTemplateColumns: '56px 1fr',
    gap: 12,
    alignItems: 'center',
    padding: '5px 0',
    borderBottom: `1px solid ${benchTheme.border}`
});

// Live readout text — accent-tinted so in-flight rows read as LIVE data
// (distinct from the muted settled-run readouts)
const EntryLiveReadout = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.accentInk,
    fontFamily: benchTheme.monoFont,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
});

// Summary tiles row (5 equal columns: Prefill / Decode / Avg TTFT /
// Avg Time / Success — the two speed metrics each get their own tile)
const EntryTiles = styledComponent('div', {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 10
});

const EntryTile = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    padding: '8px 10px',
    borderRadius: 8,
    background: benchTheme.surface,
    border: `1px solid ${benchTheme.border}`,
    minWidth: 0
});

const EntryTileLabel = styledComponent('span', {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont
});

const EntryTileValue = styledComponent('span', {
    fontSize: 14,
    fontWeight: 600,
    color: benchTheme.textPrimary,
    fontFamily: benchTheme.monoFont,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
});

// Run rows list
const EntryRuns = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 2
});

const EntryRunRow = styledComponent('div', {
    display: 'grid',
    gridTemplateColumns: '56px 1fr',
    gap: 12,
    alignItems: 'center',
    padding: '5px 0',
    borderBottom: `1px solid ${benchTheme.border}`
});

const EntryRunLabel = styledComponent('span', {
    fontSize: 11,
    color: benchTheme.textMuted,
    fontFamily: benchTheme.monoFont
});

const EntryRunReadout = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.textSecondary,
    fontFamily: benchTheme.monoFont,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
});

const EntryRunFailed = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.danger,
    fontFamily: benchTheme.monoFont,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
});

// Panel empty state
const PanelEmpty = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: '48px 20px'
});

const PanelEmptyIcon = styledComponent('span', { fontSize: 24 });

const PanelEmptyTitle = styledComponent('span', {
    fontSize: 14,
    fontWeight: 600,
    color: benchTheme.textSecondary,
    fontFamily: benchTheme.sansFont
});

const PanelEmptyHint = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont
});
