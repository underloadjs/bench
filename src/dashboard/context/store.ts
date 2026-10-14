// dashboard/context/store.ts — reactive state for the Bench dashboard.
//
// Uses @presource/react's localContextStore (propsSpy-backed proxy over a
// scoped React context — same pattern as WebstormDashboard's context store:
// packages/react/material/features/webstorm-dashboard/context/store.tsx).
//
// How it works:
// 1. BenchContextProvider merges its `data` prop into the module-level initial
//    context and provides the merged object to the subtree.
// 2. benchDashboardStore() (a hook) returns a PROXY over that shared object —
//    reading any field works like a plain object, and WRITING any field fires
//    a deferred refresh of every subscribed component.
// 3. All section modules therefore stay decoupled: the model panel can append
//    benchmark entries and the footer / header re-render automatically
//    without any prop drilling or shared callbacks through the orchestrator.
//
// The orchestrator (BenchDashboard) injects its props as `data` on mount, so
// externally-driven reports flow IN, while in-dash mutations (selection,
// live logs, benchmark entries) flow OUT via the proxy.

import { localContextStore } from '@presource/react';
import { type BenchmarkReport } from '../../core';

// Lifecycle of the dashboard from the user's point of view
export type BenchDashboardStatus = 'idle' | 'running' | 'done';

// Tone drives the log line's foreground colour in the console panel
export type BenchLogTone = 'info' | 'success' | 'error';

// One line in the live console feed
export type BenchLogEntry = {
    // Unique key for the React list (derived from position, see store actions)
    id: number;
    // HH:MM:SS stamp captured when the line was written
    time: string;
    // Human-readable message (usually produced by the engine's onLog hook)
    text: string;
    // Visual tone (info = neutral, success = green, error = red)
    tone: BenchLogTone;
};

// PROGRESSIVE FEEDBACK: live run counter inside one benchmark entry.
// Written by the compiled scenario helper (framework/scenario-kit.tsx) on
// every engine onRun — the entry's progress strip renders from it.
export type BenchEntryProgress = {
    // Runs settled so far (success + failed) within the entry
    completed: number;
    // Runs that ended in an error within the entry
    failed: number;
    // Total planned iterations for the entry
    total: number;
};

// LIVE STREAMING READOUT — one per IN-FLIGHT run inside a benchmark entry.
// Written by the compiled scenario helper (framework/scenario-kit.tsx) from
// the engine's onStream ticks (throttled — the engine fires per chunk) and
// removed the moment the run settles. The entry card renders these as live
// "N tok received" rows plus the streamed WORDS while the bench runs.
export type BenchStreamState = {
    // 0-based run index the readout belongs to
    index: number;
    // Characters received so far (accumulated across chunks)
    chars: number;
    // Estimated tokens received so far (~chars/4 — the engine's estimation
    // heuristic; provider usage only finalizes counts at settle time)
    tokens: number;
    // THE STREAMED TEXT SO FAR — the run's live output (reasoning + answer
    // concatenated), rendered as growing words while the run generates
    text: string;
    // Seconds since the run started
    elapsed: number;
    // Live sustained rate over the generation phase (post-TTFT), tok/s
    tokensPerSec: number;
};

// Lifecycle of ONE benchmark entry
export type BenchEntryStatus = 'running' | 'done';

// ONE MODEL'S EDITABLE RUN TARGET — the per-column Model + Endpoint pair,
// keyed by plugin id in the store's `targets` map. Absent = the column is
// untouched and its runs use the plugin's own binding.
export type BenchTargetOverride = {
    // Completion routing key (`model` on chat/completions).
    model: string;
    // OpenAI-compatible base URL (v1) the completions POST hits.
    endpoint: string;
};

// ONE BENCHMARK ENTRY — created per New Run click. Every click appends a new
// entry (history accumulates, newest first) and entries execute IN PARALLEL
// with each other: launching a new one never waits for a running one.
export type BenchEntry = {
    // Unique id (`bench-<n>`, from nextBenchEntryId in framework/scenario-kit)
    id: string;
    // Model the entry benchmarks (routing key + display label)
    model: string;
    modelLabel: string;
    // Scenario the entry ran (id + dropdown label)
    scenarioId: string;
    scenarioLabel: string;
    // The exact plan the entry runs with
    prompt: string;
    iterations: number;
    concurrency: number;
    // Entry lifecycle (running → done; the helper flips it on completion)
    status: BenchEntryStatus;
    // Live run counter while running (stays as the final tally when done)
    progress: BenchEntryProgress;
    // Live per-run streaming readouts while the entry runs (in-flight runs
    // only — a run's state is removed the moment it settles). Optional so
    // fixture/legacy entries without the field stay valid.
    streaming?: BenchStreamState[];
    // The (partial → final) report — committed incrementally by the helper
    // so the entry's tiles/rows update progressively as runs settle
    report: BenchmarkReport | null;
};

// Full reactive context shared across all dashboard sections.
// NOTE: must be a `type` (not an interface) — localContextStore's
// `{ [key: string]: any }` constraint only accepts literal object types.
export type BenchDashboardContext = {
    // Latest report per benchmarked model (legacy fleet view — feeds the
    // footer roll-up; per-model history lives in `entries`)
    reports: BenchmarkReport[];
    // Accumulated benchmark entries (NEWEST FIRST — each New Run appends)
    entries: BenchEntry[];
    // Dashboard-wide status, mirroring the entries' lifecycle: 'running'
    // while ANY entry is in flight, 'done' once the last one settles
    status: BenchDashboardStatus;
    // The model whose raw runs are expanded in the timeline panel
    selectedModel: string | null;
    // The SELECTED bench plugins (framework/registry.ts reconciles this
    // against the loaded plugin list — multi-select: every selected model
    // renders as a column and is benchmarked by one New Run). Empty = nothing
    // selected; the columns area shows its empty state.
    selectedPluginIds: string[];
    // Set the first time the operator toggles a rail model. While false, the
    // registry's default-once fallback may auto-select the first loaded
    // plugin (a fresh dashboard is immediately runnable); once true, an
    // explicit deselect-all STICKS (the fallback stands down — the same
    // forced-re-tick guard as the scenario dropdown's defaultedForRef).
    modelSelectionTouched: boolean;
    // Display prompt (first report's config prompt, or an explicit override)
    prompt: string;
    // Live console feed (newest LAST — the panel renders in order)
    logs: BenchLogEntry[];
    // The benchmark scenarios ticked in the panel dropdown (multi-select —
    // several scenarios can be benchmarked together in one click, one entry
    // each). Empty = nothing ticked yet; the dispatcher falls back to the
    // first scenario.
    selectedScenarioIds: string[];
    // ── THE BENCHMARK TARGETS (per selected model) ───────────────────────
    // Each selected model's column carries TWO EDITABLE fields (model id +
    // endpoint) that its runs execute against, keyed by plugin id. The
    // column's fields are their AUTOFILL source-equivalent: untouched columns
    // write nothing (runs use the plugin's own binding), the first keystroke
    // records the override so models/endpoints OUTSIDE the loaded catalog can
    // be benchmarked (the dispatcher rebuilds the provider from these).
    // Model id sent as the completion routing key (`model` on
    // chat/completions); blank/absent = fall back to the plugin's own model.
    targets: Record<string, BenchTargetOverride>;
    // ── THE RUN PLAN (durable across column changes) ─────────────────────
    // The iterations/concurrency values pinned in the execution bar's
    // RunBar. They live in the SHARED store — not in RunBar-local state —
    // because a rail selection change MOUNTS/UNMOUNTS model columns (the
    // columns host renders a different component set per selection), which
    // would wipe RunBar-local state if the RunBar itself were remounted.
    // Every fresh RunBar seeds its drafts from these, so the operator's
    // plan survives any selection change.
    // Runs per bench entry (sequential within the entry) — the RunBar's
    // Iterations input.
    planIterations: number;
    // Parallel bench entries (lanes) the run fans out into — the RunBar's
    // Concurrency input.
    planConcurrency: number;
    // Set once the operator types into either plan input: the scenario-spec
    // auto-sync (RunBar) stands down. Persisted so the pin ALSO survives
    // column mount/unmount cycles (the local planEditedRef it replaced did
    // not).
    planPinned: boolean;
    // Invoked when a comparison-row is clicked (default: local store update)
    onSelectModel: (model: string) => void;
    // Invoked by the header's "New Run" button (caller-supplied runner trigger)
    onNewRun: () => void;
};

// ── Entry cancellation registry ──────────────────────────────────────────────
// The launcher (framework/scenario-kit.tsx) owns one AbortController per
// benchmark entry and registers its canceller here, keyed by entry id. The
// cancelEntry action (driven by the entry card's hover CANCEL button) looks
// the canceller up and fires it — the run loop then aborts the in-flight
// transport request, skips queued runs, and settles the entry. The registry
// lives NEXT to the store (not in scenario-kit) to avoid an import cycle:
// scenario-kit imports the store, never the other way around.
const entryCancellers = new Map<string, () => void>();

/** Registers the canceller for a live benchmark entry (launcher-side). */
export const registerEntryCancel = (entryId: string, cancel: () => void): void => {
    entryCancellers.set(entryId, cancel);
};

/** Drops a benchmark entry's canceller (entry settled — nothing to cancel). */
export const unregisterEntryCancel = (entryId: string): void => {
    entryCancellers.delete(entryId);
};

/**
 * Fires the canceller for a live benchmark entry (no-op for unknown/settled
 * ids). Exposed standalone so tests and non-React code can cancel without
 * mounting the tree — the useBenchDashboard action below delegates here.
 */
export const cancelEntryRun = (entryId: string): void => {
    entryCancellers.get(entryId)?.();
};

// Module-level initial values — the provider's `data` prop overrides these
// per instance (see BenchDashboard.tsx for the merge).
//
// NOTE: section modules that need to MUTATE shared state (e.g. row selection)
// write through the store proxy directly (proxy `set` → deferred refresh), so
// no callback plumbing is required for internal interactions. The callbacks
// below are purely for OUTSIDERS to observe dashboard events.

// Run-plan defaults — pre-auto-sync values. The RunBar's scenario-spec
// auto-sync overwrites them from the primary scenario's own spec on first
// mount (while planPinned is still false), so these only matter for the
// bare context (tests / reset()).
const DEFAULT_PLAN_ITERATIONS = 3;
const DEFAULT_PLAN_CONCURRENCY = 1;

export const {
    ContextProvider: BenchContextProvider,
    contextStore: benchDashboardStore
} = localContextStore<BenchDashboardContext>({
    reports: [],
    entries: [],
    status: 'idle',
    selectedModel: null,
    selectedPluginIds: [],
    modelSelectionTouched: false,
    prompt: '',
    logs: [],
    selectedScenarioIds: [],
    planIterations: DEFAULT_PLAN_ITERATIONS,
    planConcurrency: DEFAULT_PLAN_CONCURRENCY,
    planPinned: false,
    // Per-model target overrides: blank by default — untouched columns run
    // against their plugin's own binding. Columns record an override on the
    // first keystroke (framework/model-kit.tsx write-through) and the
    // dispatcher rebuilds the provider from it (framework/host.tsx).
    targets: {},
    // External observation hooks — safe no-ops by default. (They must stay
    // no-op here: callbacks run outside component render, so they cannot call
    // benchDashboardStore() themselves — the store hook is render-only.)
    onSelectModel: () => {},
    onNewRun: () => {}
});

// Local clock helper for log timestamps (HH:MM:SS, 24h) — a display concern,
// hence living here rather than in the engine core.
const timeStamp = (): string => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/**
 * Convenience hook bundling the raw store with intent-named actions.
 * MUST be called by a component rendered inside <BenchContextProvider>.
 *
 * Actions mutate the shared context object through the store proxy, which
 * schedules a deferred re-render across every subscribed section.
 *
 * BenchDashboardActions is the exported shape of this return value — the
 * framework's scenario dispatcher (dashboard/framework/scenario-kit.tsx)
 * receives this bundle so launches can run OUTSIDE React render.
 */
export type BenchDashboardActions = ReturnType<typeof useBenchDashboard>;

export const useBenchDashboard = () => {
    // One subscription per component (hook-based, as required by localContextStore)
    const bench = benchDashboardStore();

    return {
        // ── Read-through state (proxy-backed, live) ─────────────────
        reports: bench.reports,
        entries: bench.entries,
        status: bench.status,
        selectedModel: bench.selectedModel,
        selectedPluginIds: bench.selectedPluginIds,
        modelSelectionTouched: bench.modelSelectionTouched,
        prompt: bench.prompt,
        logs: bench.logs,
        selectedScenarioIds: bench.selectedScenarioIds,
        planIterations: bench.planIterations,
        planConcurrency: bench.planConcurrency,
        planPinned: bench.planPinned,
        targets: bench.targets,
        // ── Actions ─────────────────────────────────────────────────
        /** Registers a finished benchmark report into the dashboard. */
        addReport: (report: BenchmarkReport) => {
            // Replace an existing report for the same model (re-runs overwrite
            // stale numbers instead of accumulating duplicate rows).
            const rest = bench.reports.filter((r) => r.model !== report.model);
            bench.reports = [...rest, report];
            // First report selects itself — the timeline never sits empty
            if (!bench.selectedModel) bench.selectedModel = report.model;
            // NOTE: status is NOT touched here — the entry lifecycle owns it
            // (addEntry/updateEntry below). Progressive reporting commits a
            // partial report per finished run while the entry is still
            // 'running', so forcing 'done' here would break the live pill.
        },
        /**
         * Appends a NEW benchmark entry (newest first) and flips the
         * dashboard-wide status to 'running'. Entries run in parallel —
         * adding one never waits for another.
         */
        addEntry: (entry: BenchEntry) => {
            bench.entries = [entry, ...bench.entries];
            bench.status = 'running';
        },
        /**
         * Patches one benchmark entry in place (progress snapshots, partial
         * reports, the final status flip). When the patched entry settles
         * and NO other entry is running, the dashboard-wide status returns
         * to 'done' — the global lifecycle is derived from the entries.
         */
        updateEntry: (entryId: string, patch: Partial<BenchEntry>) => {
            bench.entries = bench.entries.map((entry) => (entry.id === entryId ? { ...entry, ...patch } : entry));
            if (patch.status === 'done' && !bench.entries.some((entry) => entry.status === 'running')) {
                bench.status = 'done';
            }
        },
        /** Appends one line to the console feed (engine onLog → dashboard). */
        pushLog: (text: string, tone: BenchLogTone = 'info') => {
            // id from current length — safe because mutations are synchronous on
            // the shared object, so back-to-back pushes get distinct ids
            bench.logs = [...bench.logs, { id: bench.logs.length, time: timeStamp(), text, tone }];
        },
        /**
         * Cancels a RUNNING benchmark entry: aborts its in-flight transport
         * request and makes the run loop skip all queued runs. The entry
         * settles 'done' through its launcher's normal completion path (the
         * cancelled runs stay on record as error: 'cancelled'). No-op for
         * unknown or already-settled entries.
         */
        cancelEntry: (entryId: string) => {
            cancelEntryRun(entryId);
        },
        /** Sets the dashboard-wide status (e.g. external runner integration). */
        setStatus: (status: BenchDashboardStatus) => {
            bench.status = status;
        },
        /** Selects the model expanded in the run-timeline panel. */
        selectModel: (model: string) => {
            bench.selectedModel = model;
        },
        /**
         * TOGGLES a bench plugin's selection (framework rail clicks —
         * MULTI-SELECT): a selected model becomes deselected and vice versa.
         * Marks the selection as operator-touched so the registry's
         * default-once fallback stands down afterwards (a deselect-all
         * sticks). Toggling the LAST selected model off is allowed — the
         * columns area shows its empty state.
         */
        togglePlugin: (pluginId: string) => {
            const has = bench.selectedPluginIds.includes(pluginId);
            bench.selectedPluginIds = has
                ? bench.selectedPluginIds.filter((id) => id !== pluginId)
                : [...bench.selectedPluginIds, pluginId];
            bench.modelSelectionTouched = true;
        },
        /** Replaces the plugin selection (registry default/prune writes — not operator toggles). */
        selectPlugins: (pluginIds: string[]) => {
            bench.selectedPluginIds = [...pluginIds];
        },
        /** Ticks/unticks a scenario in the panel dropdown (multi-select). */
        toggleScenario: (scenarioId: string) => {
            const has = bench.selectedScenarioIds.includes(scenarioId);
            bench.selectedScenarioIds = has
                ? // untick — removing the last one is allowed (dispatcher falls
                  // back to the first scenario when nothing is selected)
                  bench.selectedScenarioIds.filter((id) => id !== scenarioId)
                : [...bench.selectedScenarioIds, scenarioId];
        },
        /** Replaces the scenario tick set (dropdown's first-scenario default). */
        selectScenarios: (scenarioIds: string[]) => {
            bench.selectedScenarioIds = [...scenarioIds];
        },
        // ── Run-plan actions (durable across model switches) ────────────
        /** Stores both plan values at once (RunBar's scenario-spec auto-sync). */
        setPlan: (iterations: number, concurrency: number) => {
            bench.planIterations = iterations;
            bench.planConcurrency = concurrency;
        },
        /** Sets the runs-per-entry plan value (RunBar Iterations write-through). */
        setPlanIterations: (iterations: number) => {
            bench.planIterations = iterations;
        },
        /** Sets the parallel-lanes plan value (RunBar Concurrency write-through). */
        setPlanConcurrency: (concurrency: number) => {
            bench.planConcurrency = concurrency;
        },
        /**
         * Pins the plan: the operator typed into a plan input, so the RunBar's
         * scenario-spec auto-sync stands down. Persisted (unlike the old
         * RunBar-local ref) so the pin survives panel remounts — model
         * switches via the rail.
         */
        pinPlan: () => {
            bench.planPinned = true;
        },
        /**
         * Records ONE column's editable run target (model id + endpoint),
         * keyed by plugin id. The column's fields write through on every
         * keystroke (framework/model-kit.tsx); the dispatcher reads the
         * override back when it builds that column's provider
         * (framework/host.tsx) — models/endpoints OUTSIDE the loaded catalog
         * are benchmarkable this way. The whole map is REPLACED (not nested
         * mutated) so the store proxy's top-level set fires the refresh.
         */
        setTarget: (pluginId: string, model: string, endpoint: string) => {
            bench.targets = { ...bench.targets, [pluginId]: { model, endpoint } };
        },
        /** Clears reports, entries, logs and selection back to the idle state. */
        reset: () => {
            bench.reports = [];
            bench.entries = [];
            bench.logs = [];
            bench.selectedModel = null;
            bench.selectedPluginIds = [];
            bench.modelSelectionTouched = false;
            bench.selectedScenarioIds = [];
            bench.planIterations = DEFAULT_PLAN_ITERATIONS;
            bench.planConcurrency = DEFAULT_PLAN_CONCURRENCY;
            bench.planPinned = false;
            bench.targets = {};
            bench.status = 'idle';
        }
    };
};
