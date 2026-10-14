// dashboard/framework/model-kit.tsx — the framework's standard model-bench recipe.
//
// `createModelBench(spec)` builds a COMPLETE per-model BenchPlugin from a
// ModelBenchSpec — this is what a model-bench plugin's factory function
// calls with the BenchFramework it receives from the dashboard (mirrors
// distribution/maths/src/framework/worksheet-kit.tsx).
//
// THE PANEL IS THE MODEL COLUMN — execution lives in the framework's
// "Scenario Execution" header (framework/host.tsx
// BenchScenarioExecutionHost); every SELECTED model renders as ONE COLUMN
// side by side (framework/host.tsx BenchPluginColumnsHost), so several
// models are benchmarked in one go:
//
//   <model name>                              ← column title
//   [Model ____]                              ← editable target fields
//   [Endpoint ____]
//   ────────────────────────────────
//   <benchmark entry — newest first>          ← run history
//   <benchmark entry>
//
// Each New Run click (the execution header) creates NEW benchmark entries
// (framework/scenario-kit.ts launchScenario) — one per ticked scenario PER
// SELECTED MODEL PER CONCURRENCY LANE — and entries run IN PARALLEL with
// each other: the Concurrency select fans each model out into that many
// side-by-side bench cards (lanes), the Iterations select sets the runs each
// lane executes sequentially. Every entry updates progressively (progress
// counter + partial report per settled run).
//
// The plugin's execution contribution is `createProvider`: the dispatcher
// (framework/host.tsx) compiles it into each scenario helper for every
// selected plugin — unless the operator edited the column's target fields,
// in which case a live HTTP provider is built from the typed values.
//
// STATE: the plugin keeps NO state of its own. Entries live in the SHARED
// framework store (dashboard/context/store.ts addEntry/updateEntry); the
// compiled scenario helper writes progress + reports into its entry, so the
// column re-renders live with zero plugin-framework coupling. The column's
// only local state is its two target-field drafts (local typing buffer)
// written through to the store per keystroke (store targets — durable across
// column unmount/remount).
import React from 'react';
import { styledComponent } from '@presource/react';
import { DEFAULT_PROVIDER_URL } from '../../core';
import {
    defineBenchPlugin,
    type BenchPlugin,
    type BenchPluginContext,
    type ModelBenchSpec
} from './types';
import { useBenchDashboard, type BenchEntry } from '../context';
import { benchTheme, formatCount, formatSeconds, formatTokensPerSec } from '../utilities';

// ── Column surface (one selected model) ──────────────────────────────────────
// The model column: editable target fields under the model name, then the
// accumulated benchmark entries (newest first, parallel, progressively
// updated). Column flex semantics live HERE (the column is the flex item of
// the columns row — framework/host.tsx ColumnsRow): every column shares the
// row's width equally and squishes (min-width: 0) as more models are added.
const createColumn = (spec: ModelBenchSpec) => {
    const ModelBenchColumn = ({ context }: { context: BenchPluginContext }) => {
        // Live shared store — every entry write re-renders this column
        const bench = useBenchDashboard();
        // THIS model's benchmark entries (the column is the model page)
        const entries = bench.entries.filter((entry) => entry.model === spec.id);

        // ── THE BENCHMARK TARGET ────────────────────────────────────────
        // The two EDITABLE fields this column's runs execute against. They
        // autofill from THIS model's own binding (spec.id + the RESOLVED
        // spec.baseUrl — dashboard/plugins/model-bench.ts) and stay freely
        // editable so models and endpoints OUTSIDE the loaded catalog can
        // be benchmarked. Drafts are the typing buffer; every keystroke
        // WRITES THROUGH to the store's per-plugin target override
        // (store.ts setTarget) — the dispatcher reads the override back
        // (framework/host.tsx), and the store value is durable across
        // column unmount/remount (deselect + reselect).
        const specEndpoint = spec.baseUrl ?? DEFAULT_PROVIDER_URL;
        const override = bench.targets[spec.id];
        const [modelDraft, setModelDraft] = React.useState(override?.model ?? spec.id);
        const [endpointDraft, setEndpointDraft] = React.useState(override?.endpoint ?? specEndpoint);

        return (
            <ColumnShell data-testid={`bench-column-${spec.id}`}>
                {/* THE MODEL COLUMN — one column per selected model:
                    <model name> / <target fields> / <benchmark entries> */}
                <ColumnTitleRow>
                    {/* Title testid kept from the old toolbar card (App test
                        asserts model columns through it) */}
                    <ColumnTitle data-testid="bench-toolbar-model">{spec.label ?? spec.id}</ColumnTitle>
                    <ColumnCount>
                        {`${entries.length} benchmark${entries.length === 1 ? '' : 's'}`}
                    </ColumnCount>
                </ColumnTitleRow>

                {/* THE TARGET FIELDS — editable model id + endpoint this
                    column's runs execute against. Show the model's own
                    binding until edited; edits write through to the store. */}
                <TargetStack>
                    <TargetField>
                        <TargetLabel>{'Model'}</TargetLabel>
                        <TargetInput
                            data-testid="bench-target-model"
                            type="text"
                            aria-label={`Benchmark target model for ${spec.label ?? spec.id}`}
                            spellCheck={false}
                            value={modelDraft}
                            placeholder={spec.id}
                            onChange={(event) => {
                                setModelDraft(event.target.value);
                                bench.setTarget(spec.id, event.target.value, endpointDraft);
                            }}
                        />
                    </TargetField>
                    <TargetField>
                        <TargetLabel>{'Endpoint'}</TargetLabel>
                        <TargetInput
                            data-testid="bench-target-endpoint"
                            type="text"
                            aria-label={`Benchmark target endpoint for ${spec.label ?? spec.id}`}
                            spellCheck={false}
                            value={endpointDraft}
                            placeholder={specEndpoint}
                            onChange={(event) => {
                                setEndpointDraft(event.target.value);
                                bench.setTarget(spec.id, modelDraft, event.target.value);
                            }}
                        />
                    </TargetField>
                </TargetStack>

                {/* BENCHMARK ENTRIES — newest first (the store prepends).
                    Each click appends a new entry; entries run in parallel. */}
                {entries.length > 0 ? (
                    <ColumnEntries>
                        {entries.map((entry) => (
                            <EntryCard key={entry.id} entry={entry} />
                        ))}
                    </ColumnEntries>
                ) : (
                    <ColumnEmpty>
                        <ColumnEmptyIcon aria-hidden="true">{'⚡'}</ColumnEmptyIcon>
                        <ColumnEmptyTitle>{'Not benchmarked yet'}</ColumnEmptyTitle>
                        <ColumnEmptyHint>{'Pick scenarios and press New Run — each run adds an entry here.'}</ColumnEmptyHint>
                    </ColumnEmpty>
                )}
            </ColumnShell>
        );
    };
    return ModelBenchColumn;
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
    // COMPLETE-DATA DIALOG: 0-based index of the settled run whose data +
    // complete output is open (null = closed). The run ROW ITSELF is the
    // control (no extra icon) — clicking any settled row that produced
    // output opens it; the overlay/✕ closes. The run is looked up from the
    // CURRENT report at render time (never a stale copy).
    const [outputIndex, setOutputIndex] = React.useState<number | null>(null);
    const outputRun = outputIndex === null ? null : (report?.runs.find((run) => run.index === outputIndex) ?? null);
    const outputReasoning = outputRun && typeof outputRun.reasoning === 'string' ? outputRun.reasoning : '';
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
                received · X tok/s" plus the STREAMED WORDS growing in place
                (cleared per run the moment it settles). This is the ongoing
                detail the column shows between "0/3 runs" and the settled
                run rows. */}
            {entry.status === 'running' && liveStreams.length > 0 ? (
                <EntryLive>
                    {liveStreams.map((stream) => (
                        <EntryLiveRow key={stream.index}>
                            <EntryRunLabel>{`run ${stream.index + 1}`}</EntryRunLabel>
                            <EntryLiveDetail>
                                <EntryLiveReadout>
                                    {`${formatCount(stream.tokens)} tok received · ${stream.tokensPerSec.toFixed(1)} tok/s · ${formatSeconds(stream.elapsed)}`}
                                </EntryLiveReadout>
                                {/* THE STREAMED WORDS: the run's live output
                                    growing in place — clipped to a small
                                    window that keeps the LATEST text visible */}
                                <EntryLiveText>{stream.text}</EntryLiveText>
                            </EntryLiveDetail>
                        </EntryLiveRow>
                    ))}
                </EntryLive>
            ) : null}
            {progress.failed > 0 ? <EntryFailed>{`${progress.failed} failed`}</EntryFailed> : null}

            {/* Summary tiles + per-iteration rows once runs have settled.
                THE TWO SPEED METRICS get their own tiles: Prefill (input —
                promptTokens / ttft) and Decode (output — the summary's
                throughput mean). Avg TTFT rounds out the trio. */}
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
                    </EntryTiles>

                    <EntryRuns>
                        {report.runs.map((run) => {
                            // A row is clickable only when the run actually
                            // produced output (failed runs carry none — the
                            // engine omits it on errors); clicking opens the
                            // complete-data dialog below
                            const hasOutput = !run.error && Boolean(run.content || run.reasoning);
                            return (
                                <EntryRunRow
                                    key={run.index}
                                    clickable={hasOutput ? 'true' : 'false'}
                                    onClick={hasOutput ? () => setOutputIndex(run.index) : undefined}
                                    onKeyDown={
                                        hasOutput
                                            ? (event) => {
                                                  if (event.key === 'Enter' || event.key === ' ') {
                                                      event.preventDefault();
                                                      setOutputIndex(run.index);
                                                  }
                                              }
                                            : undefined
                                    }
                                    role={hasOutput ? 'button' : undefined}
                                    tabIndex={hasOutput ? 0 : undefined}
                                    aria-label={hasOutput ? `View run ${run.index + 1} — complete data and output` : undefined}
                                    data-testid={`bench-run-${entry.id}-${run.index}`}
                                >
                                    <EntryRunLabel>{`run ${run.index + 1}`}</EntryRunLabel>
                                    {run.error ? (
                                        <EntryRunFailed title={run.error}>{`failed: ${run.error}`}</EntryRunFailed>
                                    ) : (
                                        <EntryRunReadout>
                                            {`${formatSeconds(run.totalTime)} · ${formatTokensPerSec(run.prefillTokensPerSec, 0)} prefill · ${run.tokensPerSec.toFixed(1)} tok/s decode · ${formatCount(run.totalTokens)} tok`}
                                        </EntryRunReadout>
                                    )}
                                </EntryRunRow>
                            );
                        })}
                    </EntryRuns>

                    {/* COMPLETE-DATA DIALOG: a modal overlay + dialog box for
                        the clicked run — its full measurement set, then the
                        COMPLETE generated output (the reasoning block first
                        when the model streamed one, then the answer text).
                        Clicking the overlay or ✕ closes; the dialog box stops
                        the propagation. */}
                    {outputRun ? (
                        <OutputOverlay
                            onClick={() => setOutputIndex(null)}
                            data-testid={`bench-output-overlay-${entry.id}`}
                        >
                            <OutputDialog
                                role="dialog"
                                aria-modal="true"
                                aria-label={`Complete data and output of run ${outputRun.index + 1}`}
                                data-testid={`bench-output-dialog-${entry.id}`}
                                onClick={(event) => event.stopPropagation()}
                            >
                                <OutputHeader>
                                    <OutputTitle>{`run ${outputRun.index + 1} — complete data`}</OutputTitle>
                                    <OutputCloseButton
                                        onClick={() => setOutputIndex(null)}
                                        aria-label="Close the output dialog"
                                        data-testid={`bench-output-close-${entry.id}`}
                                    >
                                        {'✕'}
                                    </OutputCloseButton>
                                </OutputHeader>
                                <OutputScroll>
                                    {/* THE RUN'S DATA: every measurement the
                                        collapsed row line summarizes */}
                                    <OutputStats>
                                        {[
                                            { label: 'TTFT', value: formatSeconds(outputRun.ttft) },
                                            { label: 'Total', value: formatSeconds(outputRun.totalTime) },
                                            { label: 'Start', value: formatSeconds(outputRun.startTime) },
                                            { label: 'Prefill', value: formatTokensPerSec(outputRun.prefillTokensPerSec, 0) },
                                            { label: 'Decode', value: formatTokensPerSec(outputRun.tokensPerSec) },
                                            { label: 'Prompt tok', value: formatCount(outputRun.promptTokens) },
                                            { label: 'Completion tok', value: formatCount(outputRun.completionTokens) },
                                            { label: 'Total tok', value: formatCount(outputRun.totalTokens) },
                                            { label: 'Output chars', value: formatCount(outputRun.contentLength) }
                                        ].map((stat) => (
                                            <OutputStat key={stat.label}>
                                                <OutputStatLabel>{stat.label}</OutputStatLabel>
                                                <OutputStatValue>{stat.value}</OutputStatValue>
                                            </OutputStat>
                                        ))}
                                    </OutputStats>
                                    {outputReasoning ? (
                                        <React.Fragment>
                                            <OutputSectionLabel>{'Reasoning'}</OutputSectionLabel>
                                            <OutputReasoningText>{outputReasoning}</OutputReasoningText>
                                        </React.Fragment>
                                    ) : null}
                                    {outputRun.content ? (
                                        <React.Fragment>
                                            <OutputSectionLabel>{'Output'}</OutputSectionLabel>
                                            <OutputText>{outputRun.content}</OutputText>
                                        </React.Fragment>
                                    ) : null}
                                </OutputScroll>
                            </OutputDialog>
                        </OutputOverlay>
                    ) : null}
                </React.Fragment>
            ) : null}
        </EntryShell>
    );
};

// ── Target fields (editable model + endpoint the runs execute against) ──────
// Stacked vertically (narrow columns): label above input. Edits write
// through to the store's per-plugin target override (framework/host.tsx
// dispatch rebuilds the provider from these).

// Column field stack: the two editable target fields
const TargetStack = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    width: '100%',
    minWidth: 0
});

const TargetField = styledComponent('label', {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0
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
    width: '100%',
    boxSizing: 'border-box',
    minWidth: 0,
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
// the model column (rendered once per selection), and the provider factory
// the dispatcher compiles into each scenario helper (the model's whole
// execution contribution).
export function createModelBench(spec: ModelBenchSpec): BenchPlugin {
    return defineBenchPlugin({
        id: spec.id,
        name: `${spec.label ?? spec.id} Bench`,
        // THE RAIL LABEL: one entry, the plugin's own model. The entry also
        // carries the model's own binding (model + endpoint) — the column's
        // target fields autofill from it and the dispatcher falls back to it
        // for untouched columns.
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
        panel: createColumn(spec),
        // The execution binding: the dispatcher builds THIS model's provider
        // (HTTP transport bound to the catalog base URL, or an injected
        // demo/stub transport) per launch. Without it the model cannot be
        // benchmarked.
        createProvider: spec.createProvider
    });
}

// Re-exported for the framework barrel (framework.ts references it).
export { useBenchDashboard };

// ── Styled components (framework chrome, shared by all model benches) ───────

// Model column shell: the flex item of the columns row (framework/host.tsx
// ColumnsRow). Every column shares the row's width equally and SQUISHES
// (min-width: 0) as more models are selected — the row never wraps.
const ColumnShell = styledComponent('div', {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '14px 16px',
    background: benchTheme.surface,
    border: `1px solid ${benchTheme.border}`,
    borderRadius: benchTheme.radius,
    boxShadow: benchTheme.shadow
});

// Column title row (model name + entry count)
const ColumnTitleRow = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 12,
    minWidth: 0
});

const ColumnTitle = styledComponent('h3', {
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

const ColumnCount = styledComponent('span', {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont,
    flexShrink: 0,
    whiteSpace: 'nowrap'
});

// Benchmark entries list (newest first — the store prepends)
const ColumnEntries = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    // Divider between the target fields and the run history
    borderTop: `1px solid ${benchTheme.border}`,
    paddingTop: 14
});

// One entry: a soft inset card inside the model column
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
// every run settled; same leading columns as the settled run rows below)
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

// In-flight detail stack: the counts line + the streamed words below it
const EntryLiveDetail = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0
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

// THE STREAMED WORDS — the run's live output growing in place while chunks
// land. Clipped to a small window; the flex-end alignment keeps the LATEST
// text in view as the block outgrows the cap (the top scrolls out).
const EntryLiveText = styledComponent('div', {
    fontFamily: benchTheme.monoFont,
    fontSize: 11,
    lineHeight: 1.5,
    color: benchTheme.textSecondary,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 84,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end'
});

// Summary tiles row (3 equal columns: Prefill / Decode / Avg TTFT —
// the two speed metrics each get their own tile)
const EntryTiles = styledComponent('div', {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
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

// One run row. The row itself is the control: runs that produced output are
// clickable (pointer cursor + keyboard focusable) and open the complete-data
// dialog; failed rows stay inert.
const EntryRunRow = styledComponent<{ clickable: string }>('div', {
    display: 'grid',
    gridTemplateColumns: '56px 1fr',
    gap: 12,
    alignItems: 'center',
    padding: '5px 0',
    borderBottom: `1px solid ${benchTheme.border}`,
    cursor: ({ clickable }) => (clickable === 'true' ? 'pointer' : 'default'),
    outline: 'none'
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

// ── Per-run complete-data affordance (row click → dialog) ────────────────────
// Settled rows that produced output are clickable and open the modal dialog
// with that run's full measurements + complete generated output. Failed runs
// carry no output → their rows stay inert.

// The modal overlay: dims the page and centers the dialog box; clicking it
// closes (the dialog box stops the propagation)
const OutputOverlay = styledComponent('div', {
    position: 'fixed',
    inset: 0,
    zIndex: 60,
    background: 'rgba(0, 0, 0, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24
});

// The dialog box: capped height, header on top, the output scrolling INSIDE
// so even thousand-word generations stay navigable
const OutputDialog = styledComponent('div', {
    background: benchTheme.surface,
    border: `1px solid ${benchTheme.border}`,
    borderRadius: benchTheme.radius,
    boxShadow: benchTheme.shadow,
    width: '100%',
    maxWidth: 720,
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '16px 18px'
});

// Dialog header: title + close button on one line
const OutputHeader = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexShrink: 0
});

const OutputTitle = styledComponent('span', {
    fontSize: 13,
    fontWeight: 700,
    color: benchTheme.textPrimary,
    fontFamily: benchTheme.sansFont,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis'
});

const OutputCloseButton = styledComponent('button', {
    border: 'none',
    background: 'transparent',
    color: benchTheme.textMuted,
    fontSize: 13,
    lineHeight: 1,
    padding: '4px 6px',
    borderRadius: 6,
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: benchTheme.sansFont
});

// The run's measurement grid inside the dialog (3 equal columns of stat
// tiles — the data the collapsed row line summarized)
const OutputStats = styledComponent('div', {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
    flexShrink: 0
});

// One stat tile in the dialog's measurement grid
const OutputStat = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '7px 10px',
    borderRadius: 8,
    background: benchTheme.surfaceFaint,
    border: `1px solid ${benchTheme.border}`,
    minWidth: 0
});

const OutputStatLabel = styledComponent('span', {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
});

const OutputStatValue = styledComponent('span', {
    fontSize: 13,
    fontWeight: 600,
    color: benchTheme.textPrimary,
    fontFamily: benchTheme.monoFont,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
});

// The scrollable output area inside the dialog (stats + reasoning + answer
// stack)
const OutputScroll = styledComponent('div', {
    overflow: 'auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10
});

// Section caption ("Reasoning") above an output block
const OutputSectionLabel = styledComponent('span', {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont,
    flexShrink: 0
});

// One pre-wrapped output block (the answer); reasoning renders in its own
// muted variant below
const OutputText = styledComponent('div', {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: benchTheme.monoFont,
    fontSize: 12,
    lineHeight: 1.6,
    color: benchTheme.textPrimary,
    background: benchTheme.surfaceFaint,
    border: `1px solid ${benchTheme.border}`,
    borderRadius: 8,
    padding: 12
});

const OutputReasoningText = styledComponent('div', {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: benchTheme.monoFont,
    fontSize: 12,
    lineHeight: 1.6,
    color: benchTheme.textSecondary,
    background: benchTheme.surfaceFaint,
    border: `1px solid ${benchTheme.border}`,
    borderRadius: 8,
    padding: 12
});

// Column empty state
const ColumnEmpty = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: '40px 16px'
});

const ColumnEmptyIcon = styledComponent('span', { fontSize: 24 });

const ColumnEmptyTitle = styledComponent('span', {
    fontSize: 14,
    fontWeight: 600,
    color: benchTheme.textSecondary,
    fontFamily: benchTheme.sansFont
});

const ColumnEmptyHint = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont,
    textAlign: 'center'
});
