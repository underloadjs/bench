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
// VALUE import (not type-only): DEFAULT_PROVIDER_URL seeds the endpoint
// target field. No cycle — core never imports the dashboard context.
import { DEFAULT_PROVIDER_URL, type BenchmarkReport } from '../../core';

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
// "N tok received" rows while the bench runs.
export type BenchStreamState = {
    // 0-based run index the readout belongs to
    index: number;
    // Characters received so far (accumulated across chunks)
    chars: number;
    // Estimated tokens received so far (~chars/4 — the engine's estimation
    // heuristic; provider usage only finalizes counts at settle time)
    tokens: number;
    // Seconds since the run started
    elapsed: number;
    // Live sustained rate over the generation phase (post-TTFT), tok/s
    tokensPerSec: number;
};

// Lifecycle of ONE benchmark entry
export type BenchEntryStatus = 'running' | 'done';

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
    // The ACTIVE bench plugin (framework/registry.ts reconciles this against
    // the loaded plugin list — '' = nothing selected, falls back to first)
    selectedPluginId: string;
    // Display prompt (first report's config prompt, or an explicit override)
    prompt: string;
    // Live console feed (newest LAST — the panel renders in order)
    logs: BenchLogEntry[];
    // The benchmark scenarios ticked in the panel dropdown (multi-select —
    // several scenarios can be benchmarked together in one click, one entry
    // each). Empty = nothing ticked yet; the dispatcher falls back to the
    // first scenario.
    selectedScenarioIds: string[];
    // ── THE BENCHMARK TARGET ────────────────────────────────────────────
    // The two EDITABLE fields every run executes against. The rail menu is
    // their AUTOFILL source: activating a model snaps both fields to that
    // model's binding (applyTarget — rail click in framework/host.tsx +
    // the panel's activation effect in framework/model-kit.tsx). Both stay
    // freely editable so models/endpoints OUTSIDE the loaded catalog can
    // be benchmarked (the provider is rebuilt from these at launch).
    // Model id sent as the completion routing key (`model` on
    // chat/completions). Empty = fall back to the active plugin's own id.
    targetModel: string;
    // OpenAI-compatible base URL (v1) the completions POST hits. Empty =
    // fall back to the active plugin's own endpoint.
    targetEndpoint: string;
    // ── THE RUN PLAN (durable across models) ─────────────────────────────
    // The iterations/concurrency values pinned in the panel's RunBar. They
    // live in the SHARED store — not in RunBar-local state — because a rail
    // switch UNMOUNTS the active model's panel and mounts the next model's
    // (BenchPluginPanelHost renders a different component per plugin), which
    // would wipe RunBar-local state. Every model panel's RunBar seeds its
    // drafts from these, so the operator's plan follows them across models.
    // Runs per bench entry (sequential within the entry) — the RunBar's
    // Iterations input.
    planIterations: number;
    // Parallel bench entries (lanes) the run fans out into — the RunBar's
    // Concurrency input.
    planConcurrency: number;
    // Set once the operator types into either plan input: the scenario-spec
    // auto-sync (RunBar) stands down. Persisted so the pin ALSO survives
    // panel remounts (the local planEditedRef it replaces did not).
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
    selectedPluginId: '',
    prompt: '',
    logs: [],
    selectedScenarioIds: [],
    planIterations: DEFAULT_PLAN_ITERATIONS,
    planConcurrency: DEFAULT_PLAN_CONCURRENCY,
    planPinned: false,
    // Target fields: blank model (falls back to the active plugin's id) +
    // the standard LAN provider endpoint. Panels autofill both on
    // activation (framework/model-kit.tsx) and rail clicks re-apply
    // (framework/host.tsx) — these are just the pre-activation defaults.
    targetModel: '',
    targetEndpoint: DEFAULT_PROVIDER_URL,
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
        selectedPluginId: bench.selectedPluginId,
        prompt: bench.prompt,
        logs: bench.logs,
        selectedScenarioIds: bench.selectedScenarioIds,
        planIterations: bench.planIterations,
        planConcurrency: bench.planConcurrency,
        planPinned: bench.planPinned,
        targetModel: bench.targetModel,
        targetEndpoint: bench.targetEndpoint,
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
        /** Activates a bench plugin (framework rail clicks / registry fallback). */
        selectPlugin: (pluginId: string) => {
            bench.selectedPluginId = pluginId;
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
        /** Sets the model id the next runs execute against (panel Model field). */
        setTargetModel: (model: string) => {
            bench.targetModel = model;
        },
        /** Sets the endpoint base URL the next runs execute against (panel Endpoint field). */
        setTargetEndpoint: (endpoint: string) => {
            bench.targetEndpoint = endpoint;
        },
        /**
         * AUTOFILL: snaps BOTH target fields at once — the rail menu's
         * whole purpose. Called from the rail click handler
         * (framework/host.tsx) and the panel's activation effect
         * (framework/model-kit.tsx) with the model's own binding.
         */
        applyTarget: (model: string, endpoint: string) => {
            bench.targetModel = model;
            bench.targetEndpoint = endpoint;
        },
        /** Clears reports, entries, logs and selection back to the idle state. */
        reset: () => {
            bench.reports = [];
            bench.entries = [];
            bench.logs = [];
            bench.selectedModel = null;
            bench.selectedPluginId = '';
            bench.selectedScenarioIds = [];
            bench.planIterations = DEFAULT_PLAN_ITERATIONS;
            bench.planConcurrency = DEFAULT_PLAN_CONCURRENCY;
            bench.planPinned = false;
            bench.targetModel = '';
            bench.targetEndpoint = DEFAULT_PROVIDER_URL;
            bench.status = 'idle';
        }
    };
};
