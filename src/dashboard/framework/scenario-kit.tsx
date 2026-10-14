// dashboard/framework/scenario-kit.tsx — the framework's scenario recipe, the
// COMPILED HELPER handed to scenario plugins, and the entry LAUNCHER.
//
// A scenario plugin only describes a test (prompt + iteration plan). The
// framework does the rest at launch time:
//
//   launchScenario()  — creates a NEW benchmark entry in the shared store
//                       (one per scenario per Run click), compiles a helper
//                       bound to it, and awaits the scenario's execute().
//                       Launches are fire-and-forget: entries run IN
//                       PARALLEL with each other.
//
//   compileScenarioHelper() — binds the scenario spec + the target
//                       provider + the entry id + the store actions into one
//                       helper whose `run()`:
//                         - drives the core engine (runBench);
//                         - streams engine log lines into the console feed;
//                         - updates the entry's progress counter on EVERY
//                           settled run (progressive feedback);
//                         - commits a PARTIAL report per settled run so the
//                           entry's rows update live, then the authoritative
//                           full report once the bench settles.
//
// createScenario(spec) is the standard recipe: a plugin whose execute just
// calls helper.run() with its own plan. Custom scenarios may orchestrate
// several helper.run() calls (they receive the whole helper).
//
// TIMING INJECTION: the helper accepts an optional { clock, now } pair that
// passes straight through to runBench's hooks — this is what makes the
// helper fully deterministic in tests (fake clock → exact timings).
import { runBench, summarizeRuns, type BenchRun, type BenchmarkReport } from '../../core';
import { registerEntryCancel, unregisterEntryCancel, type BenchEntry, type BenchStreamState } from '../context';
import type {
    BenchScenarioActions,
    BenchScenarioHelper,
    BenchScenarioPlugin,
    BenchScenarioSpec
} from './types';
import { defineBenchScenario } from './types';

// Injectable timing sources (mirrors core BenchHooks) — tests pass a fake
// clock so every timing/assert is exact.
export type BenchScenarioTiming = {
    // Monotonic ms clock (see core/runner.ts defaultClock).
    clock?: () => number;
    // ISO timestamp source for report.createdAt.
    now?: () => string;
    // Throttle clock for the live streaming pushes (see
    // createStreamPublisher). MUST be independent of `clock` — the publisher
    // samples it on every push, and extra samples would shift the pinned
    // clock sequences runBench's timings rely on. Defaults to Date.now().
    streamClock?: () => number;
};

// The iteration/concurrency plan a launch can pin (panel controls). Values
// here OVERRIDE the scenario spec's defaults (per-call overrides in
// helper.run() win over both).
export type BenchPlanOverride = Partial<Pick<BenchScenarioSpec, 'prompt' | 'iterations' | 'concurrency'>>;

// What compileScenarioHelper needs: the scenario spec, the target provider,
// the entry to report into, the store actions, an optional plan pin, an
// optional timing injection, and the entry's cancellation signal (absent =
// never-aborted; direct-helper callers that don't care about cancellation
// can omit it).
export type BenchScenarioHelperInput = {
    spec: BenchScenarioSpec;
    provider: BenchScenarioHelper['provider'];
    // The benchmark entry this helper reports into.
    entryId: string;
    actions: BenchScenarioActions;
    // Plan pinned at launch (panel's iteration/concurrency selects) —
    // layered over the spec defaults, under per-call overrides.
    plan?: BenchPlanOverride;
    timing?: BenchScenarioTiming;
    // ENTRY CANCELLATION signal (launchScenario passes the entry's
    // controller.signal; see BenchScenarioHelper.signal).
    signal?: AbortSignal;
};

// ── Console tone for engine log lines ────────────────────────────────────────
// (see the message shapes in core/runner.ts: "run … FAILED …" / "finish …").
// Shared by the helper and any custom scenario that logs engine output.
export const toneFor = (text: string): 'info' | 'success' | 'error' => {
    if (text.includes('FAILED')) return 'error';
    if (text.startsWith('finish')) return 'success';
    return 'info';
};

// Resolves the effective plan: per-call override > pinned launch plan > spec
// (sanitized the same way the runner does — integers ≥ 1, defaults 3 / 1).
const resolvePlan = (spec: BenchScenarioSpec, pinned?: BenchPlanOverride, override?: BenchPlanOverride) => ({
    prompt: override?.prompt ?? pinned?.prompt ?? spec.prompt,
    iterations: Math.max(1, Math.floor(override?.iterations ?? pinned?.iterations ?? spec.iterations ?? 3)),
    concurrency: Math.max(1, Math.floor(override?.concurrency ?? pinned?.concurrency ?? spec.concurrency ?? 1))
});

// ── Entry id sequence ────────────────────────────────────────────────────────
// Module-level counter — every New Run click gets a fresh, unique entry id.
let entrySeq = 0;
export const nextBenchEntryId = (): string => `bench-${(entrySeq += 1)}`;

// ── Live streaming feedback plumbing ─────────────────────────────────────────
// The engine fires onStream on EVERY chunk (very high frequency) — writes to
// the shared store are therefore throttled to this interval (a run's FIRST
// tick is always pushed immediately so the in-flight row appears without
// delay). The throttle clock is INDEPENDENT of the timing clock (see
// BenchScenarioTiming.streamClock): sampling it must never shift the pinned
// clock sequences runBench's measured timings rely on. Tests inject a fake
// streamClock advancing ≥150ms per call so every push passes the throttle
// and stays deterministic.
export const STREAM_PUSH_INTERVAL_MS = 150;

// The publisher's contract: record an engine tick into its run's live
// readout (pushing throttled, or immediately when `first`), drop a run's
// readout when it settles, and snapshot the current readouts (sorted by run
// index so the entry card's live rows render in stable order).
export type BenchStreamPublisher = {
    record: (tick: BenchStreamState, first?: boolean) => void;
    remove: (index: number) => void;
    states: () => BenchStreamState[];
};

// Compiles the per-entry stream publisher shared by the helper's
// onStream/onRun hooks (and by the growing-context scenario's own executor
// shape — see scenarios/growing-context.ts for the same plumbing inlined).
export const createStreamPublisher = (
    entryId: string,
    actions: BenchScenarioActions,
    clock: () => number
): BenchStreamPublisher => {
    // One live readout per in-flight run (run index → latest tick)
    const streams = new Map<number, BenchStreamState>();
    let lastPush = 0;

    // Throttled store write: a full `streaming` snapshot sorted by run index
    const push = (force: boolean) => {
        const stamp = clock();
        if (!force && stamp - lastPush < STREAM_PUSH_INTERVAL_MS) return;
        lastPush = stamp;
        actions.updateEntry(entryId, { streaming: [...streams.values()].sort((a, b) => a.index - b.index) });
    };

    return {
        // Upsert the tick into the run's live readout, then push unless the
        // throttle says otherwise (`first` ticks always push)
        record: (tick, first = false) => {
            streams.set(tick.index, tick);
            push(first);
        },
        // The run settled — its live readout leaves the entry's strip
        remove: (index: number) => {
            streams.delete(index);
        },
        // Current readouts, run-index order (safe snapshot for patches)
        states: () => [...streams.values()].sort((a, b) => a.index - b.index)
    };
};

/**
 * Compiles the helper passed into a scenario plugin's execute().
 *
 * The helper's `run()` owns the progressive-feedback contract for ONE entry:
 * progress counter per settled run, partial report per settled run, final
 * report + status flip at the end.
 */
export function compileScenarioHelper(input: BenchScenarioHelperInput): BenchScenarioHelper {
    const { spec, provider, entryId, actions, plan: pinned, timing } = input;

    // The entry's cancellation signal — direct-helper callers that don't
    // wire cancellation get a never-aborted stand-in so the helper contract
    // (signal: AbortSignal) always holds
    const signal = input.signal ?? new AbortController().signal;

    // The compile-time effective plan (spec defaults < pinned launch plan) —
    // exposed on the helper for custom scenarios that orchestrate their own
    // execution instead of calling run().
    const compilePlan = resolvePlan(spec, pinned);

    // The run action — everything pre-wired, scenarios just await it.
    const run: BenchScenarioHelper['run'] = async (planOverride) => {
        // Resolve the plan (spec defaults < pinned launch plan < per-call)
        const plan = resolvePlan(spec, pinned, planOverride);

        // Reset the entry's counter + streaming strip for this run (a custom
        // scenario may run its helper more than once — each run restarts the
        // feedback)
        actions.updateEntry(entryId, { progress: { completed: 0, failed: 0, total: plan.iterations }, streaming: [] });

        // Runs settled so far — feeds the progressive partial reports.
        const collected: BenchRun[] = [];
        let failed = 0;

        // LIVE STREAMING FEEDBACK: one readout per in-flight run, pushed to
        // the entry throttled (per-chunk ticks are far too frequent to write
        // on every event). The throttle clock is the injected streamClock
        // when present (deterministic tests), else Date.now — NEVER the
        // timing clock, whose sample count runBench's timings depend on. The
        // entry card renders the readouts as live "N tok received" rows and
        // each readout is removed the moment its run settles (onRun below).
        const publisher = createStreamPublisher(
            entryId,
            actions,
            timing?.streamClock ?? (() => Date.now())
        );

        const report: BenchmarkReport = await runBench(provider, { ...plan, signal }, {
            // Timing injection keeps tests deterministic (defaults = real clock)
            clock: timing?.clock,
            now: timing?.now,
            // Engine log lines → shared console feed, coloured by tone
            onLog: (text) => actions.pushLog(text, toneFor(text)),
            // LIVE STREAMING: fired by the engine on EVERY streamed chunk —
            // record the in-flight readout (throttled push; the run's first
            // chunk always pushes so the row appears without delay)
            onStream: (tick) => {
                publisher.record(
                    {
                        index: tick.index,
                        chars: tick.chars,
                        tokens: tick.tokens,
                        text: tick.text,
                        elapsed: tick.elapsed,
                        tokensPerSec: tick.tokensPerSec
                    },
                    tick.first
                );
            },
            // PROGRESSIVE UPDATE: fired by the engine after EVERY run
            // (success or failure) — advance the entry's counter, retire the
            // settled run's live readout and commit a partial report so its
            // rows render live.
            onRun: (run) => {
                collected.push(run);
                if (run.error) failed += 1;
                publisher.remove(run.index);
                const progress = { completed: collected.length, failed, total: plan.iterations };
                actions.updateEntry(entryId, { progress, streaming: publisher.states() });
                // Partial report: only the runs finished so far, summarized
                // through the real engine aggregator. wallTime is unknown
                // mid-flight → 0 (the em-dash convention renders it quiet).
                const partial: BenchmarkReport = {
                    model: provider.model,
                    config: { ...plan },
                    createdAt: timing?.now ? timing.now() : new Date().toISOString(),
                    wallTime: 0,
                    runs: [...collected],
                    summary: summarizeRuns(provider.model, collected, 0)
                };
                actions.updateEntry(entryId, { report: partial });
                // Latest-per-model fleet view (footer roll-up) stays fresh too
                actions.addReport(partial);
            }
        });

        // Final report: full run list + real wallTime + final summary, and
        // the entry settles (updateEntry flips the global status to 'done'
        // once no other entry is running — see context/store.ts).
        actions.addReport(report);
        actions.updateEntry(entryId, { status: 'done', report });
        return report;
    };

    return { scenario: spec, provider, entryId, signal, plan: compilePlan, run, actions };
}

// What launchScenario needs: the scenario to run, the target model (id +
// display label + provider factory), the store actions, the plan pinned by
// the panel's controls, and optional timing injection for tests.
export type BenchLaunchInput = {
    scenario: BenchScenarioPlugin;
    modelId: string;
    modelLabel: string;
    provider: BenchScenarioHelper['provider'];
    actions: BenchScenarioActions & { addEntry: (entry: BenchEntry) => void };
    plan?: BenchPlanOverride;
    timing?: BenchScenarioTiming;
    // Display-label override for the benchmark ENTRY's scenario caption.
    // The concurrency fan-out (model-kit handleRun) launches SEVERAL parallel
    // entries of the SAME scenario — the lane tag ("· lane 2") is what makes
    // the parallel benches tell each other apart on the panel. The scenario
    // spec's own label is untouched.
    entryLabel?: string;
};

/**
 * Creates a NEW benchmark entry and executes the scenario against it.
 *
 * One call = one entry (each Run click launches one per ticked scenario).
 * The returned promise resolves when the scenario's execute settles — but
 * callers are expected to fire-and-forget (`void launchScenario(…)`) so
 * entries run IN PARALLEL with each other. Errors never escape: a throwing
 * execute (or provider construction failure) lands in the console feed and
 * the entry settles as 'done'.
 */
export async function launchScenario(input: BenchLaunchInput): Promise<void> {
    const { scenario, modelId, modelLabel, provider, actions, plan, timing, entryLabel } = input;

    // Resolve the plan the entry will run with (spec defaults < pinned plan)
    const effective = resolvePlan(scenario.spec, plan);

    // THE ENTRY: one per launch, appended newest-first by the store. The
    // store flips the dashboard-wide status to 'running' on append.
    const entryId = nextBenchEntryId();
    const entry: BenchEntry = {
        id: entryId,
        model: modelId,
        modelLabel,
        scenarioId: scenario.id,
        // Entry caption: the lane-labelled override when the dispatcher fans
        // out parallel lanes of the same scenario, else the spec's label
        scenarioLabel: entryLabel ?? scenario.spec.label,
        prompt: effective.prompt,
        iterations: effective.iterations,
        concurrency: effective.concurrency,
        status: 'running',
        progress: { completed: 0, failed: 0, total: effective.iterations },
        // Live streaming readouts start empty — the compiled helper fills
        // them from the engine's onStream ticks while runs generate
        streaming: [],
        report: null
    };
    actions.addEntry(entry);

    // ENTRY CANCELLATION: one AbortController per entry. The canceller is
    // registered in the shared store registry so the entry card's CANCEL
    // button (store cancelEntry action) can abort THIS entry: in-flight
    // transport requests reject, queued runs are skipped as 'cancelled',
    // and the entry settles through the normal completion path below.
    const controller = new AbortController();
    registerEntryCancel(entryId, () => controller.abort());

    // Compile the helper bound to THIS entry and hand it to the scenario
    const helper = compileScenarioHelper({
        spec: scenario.spec,
        provider,
        entryId,
        actions,
        plan: effective,
        timing,
        signal: controller.signal
    });

    try {
        await scenario.execute(helper);
    } catch (error: unknown) {
        // Per-run errors never throw out of runBench (they land in
        // run.error) — this catches provider CONSTRUCTION failures or a
        // misbehaving custom scenario execute. A cancellation abort is not
        // an accident: settle quietly with the canonical message.
        const message = controller.signal.aborted ? 'cancelled' : error instanceof Error ? error.message : String(error);
        actions.pushLog(controller.signal.aborted ? `bench ${entryId} cancelled` : `bench aborted: ${message}`, controller.signal.aborted ? 'info' : 'error');
    } finally {
        // The entry is settled (or abandoned) — its canceller has no purpose
        // anymore; dropping it keeps the registry from growing per run
        unregisterEntryCancel(entryId);
        // Settle the entry no matter what (custom executes that never call
        // helper.run would otherwise stay 'running' forever; for the normal
        // path this is an idempotent no-op patch).
        actions.updateEntry(entryId, { status: 'done' });
    }
}

/**
 * The framework's standard scenario recipe: builds a complete scenario
 * plugin from a spec. The default execute simply runs the compiled helper —
 * scenarios that need more orchestration pass their own `execute`.
 */
export function createScenario(spec: BenchScenarioSpec, execute?: BenchScenarioPlugin['execute']): BenchScenarioPlugin {
    return defineBenchScenario({
        id: spec.id,
        name: `${spec.label} Scenario`,
        spec,
        // Default execution: run the compiled helper with the scenario's own
        // plan. The helper carries the provider + entry + store actions.
        execute: execute ?? ((helper) => helper.run())
    });
}
