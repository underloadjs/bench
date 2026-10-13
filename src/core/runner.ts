// core/runner.ts — the benchmark execution engine.
//
// runBench() drives a BenchProvider through N iterations of a fixed prompt and
// produces a BenchmarkReport (raw runs + aggregated summary).
//
// Design notes:
// - CONCURRENCY: iterations are scheduled through @presource/core's taskCompletion
//   bounded-concurrency queue, so `concurrency: 1` is strictly sequential while
//   `concurrency: 4` keeps 4 generations in flight. Per-run timing is measured
//   around each run's OWN call, so concurrent runs don't skew each other's
//   ttft/totalTime (wallTime still reflects the shared real clock).
// - DETERMINISM: the clock and timestamp sources are injectable (BenchHooks),
//   which makes the engine fully testable — tests pass a fake ms clock and a
//   fixed ISO date, then assert exact report values.
// - ROBUSTNESS: a throwing provider NEVER breaks the benchmark — the error is
//   captured into the run (run.error) and the iteration counts as a failure,
//   exactly like a timed-out request would.
// - TOKEN ESTIMATION: when the provider omits usage, tokens are estimated as
//   ceil(charCount / 4) — the same heuristic used by
//   packages/test/models/src/benchmark-model.ts:159 so results stay comparable.

import { numberEnsures, taskCompletion } from '@presource/core';
import { summarizeRuns } from './summarize';
import type { BenchConfig, BenchGeneration, BenchHooks, BenchProvider, BenchRun, BenchStreamTick, BenchmarkReport } from './types';

// Default ms clock: prefers performance.now() (higher resolution) with a
// Date.now() fallback for runtimes without a global performance object.
const defaultClock = (): number => {
    // `globalThis.performance` exists in Node 16+ and all modern browsers
    const perf = globalThis.performance as { now?: () => number } | undefined;
    return perf?.now ? perf.now() : Date.now();
};

// Default timestamp source for report.createdAt
const defaultNow = (): string => new Date().toISOString();

/**
 * Builds the canonical CANCELLED run record (error: 'cancelled') used both
 * for runs aborted mid-flight and for queued runs skipped after a cancel —
 * all token/speed fields stay 0 so summary stats exclude them.
 */
const cancelledRun = (index: number, benchStart: number, clock: () => number): BenchRun => ({
    index,
    startTime: (clock() - benchStart) / 1000,
    ttft: 0,
    totalTime: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    contentLength: 0,
    prefillTokensPerSec: 0,
    tokensPerSec: 0,
    error: 'cancelled'
});

/**
 * Executes a single benchmark iteration against the provider and measures it.
 * Never throws — provider errors are captured into the returned BenchRun.
 *
 * @param provider   - The model adapter to measure.
 * @param prompt     - The fixed prompt sent on every iteration.
 * @param index      - The 0-based iteration index (becomes run.index).
 * @param benchStart - ms timestamp of the bench start (for run.startTime).
 * @param clock      - ms clock (injectable for deterministic tests).
 * @param onStream   - Optional live-streaming hook, fired on EVERY chunk
 *                     (see BenchStreamTick) so a UI can show in-flight
 *                     "N tok received" readouts while the run generates.
 * @param signal     - Optional cancellation signal: forwarded to the provider
 *                     (streaming transports abort the underlying fetch) and
 *                     used to map abort rejections to a 'cancelled' error.
 */
const measureRun = async (
    provider: BenchProvider,
    prompt: string,
    index: number,
    benchStart: number,
    clock: () => number,
    onStream?: (tick: BenchStreamTick) => void,
    signal?: AbortSignal
): Promise<BenchRun> => {
    // Already cancelled before the run even started — record it as cancelled
    // without contacting the provider
    if (signal?.aborted) return cancelledRun(index, benchStart, clock);

    // Mark the moment THIS run begins (relative to bench start for startTime)
    const runStart = clock();
    // ttft is captured on the first streamed chunk; stays 0 when the provider
    // never emits a chunk (non-streaming or failed before first token)
    let ttft = 0;
    let firstToken = true;
    // Characters received so far in THIS run — accumulated across chunks and
    // reported live through onStream (est. tokens = ceil(chars / 4), the same
    // heuristic the final token accounting uses when usage is missing)
    let received = 0;

    try {
        // Stream the completion; each chunk re-enters here to stamp TTFT once
        // and fire a live streaming tick. IMPORTANT: exactly ONE clock read
        // per chunk — extra reads would shift the clock-pinned sequences the
        // deterministic tests (and TTFT math) rely on. The cancellation
        // signal rides along so streaming transports abort the request.
        const result: BenchGeneration = await provider.generate(
            prompt,
            (chunk: string) => {
                const stamp = clock();
                if (firstToken) {
                    // First-chunk latency is the standard TTFT definition
                    ttft = (stamp - runStart) / 1000;
                    firstToken = false;
                    // chunk content is intentionally ignored for the report — the
                    // provider returns the full text in the resolve value (matches
                    // ChatCompletion.stream)
                }

                // LIVE STREAMING FEEDBACK: accumulate the received text and fire a
                // tick so a UI can show "N tok received · X tok/s" while the run
                // is still generating. `first` flags the run's first chunk
                // (received was 0 before this chunk landed).
                if (onStream) {
                    received += chunk.length;
                    const elapsed = (stamp - runStart) / 1000;
                    // Live sustained rate mirrors the final tokensPerSec math —
                    // measured over the generation phase only (post-TTFT),
                    // guarded against a zero-length phase (the first chunk lands
                    // exactly AT ttft, so its rate reads 0 by definition)
                    const generationPhase = elapsed - ttft;
                    const tokens = Math.ceil(received / 4);
                    onStream({
                        index,
                        chars: received,
                        tokens,
                        elapsed,
                        tokensPerSec: generationPhase > 0 ? tokens / generationPhase : 0,
                        first: received === chunk.length
                    });
                }
            },
            signal
        );

        // Stamp completion; totalTime = (end - runStart) in seconds
        const timeEnd = clock();
        const totalTime = (timeEnd - runStart) / 1000;

        // Coerce content defensively — a misbehaving provider may return null-ish
        const content = typeof result?.content === 'string' ? result.content : '';
        // Reasoning models stream their chain of thought separately (the
        // transport accumulates it out-of-band, see core/provider.ts) — those
        // tokens ARE output, so the estimate fallback counts them too
        const reasoning = typeof result?.reasoning === 'string' ? result.reasoning : '';
        const usage = result?.usage;

        // Token accounting: prefer provider usage, else estimate ~1 token / 4 chars.
        // The estimate covers the FULL generated output (answer + reasoning);
        // contentLength below stays the ANSWER length (the replayable text).
        const promptTokens = numberEnsures(usage?.promptTokens) || Math.max(1, Math.ceil(prompt.length / 4));
        const completionTokens = numberEnsures(usage?.completionTokens) || Math.ceil((content.length + reasoning.length) / 4);
        const totalTokens = numberEnsures(usage?.totalTokens) || promptTokens + completionTokens;

        // THE TWO SPEED METRICS (input / output are measured separately):
        // - PREFILL (input): promptTokens / ttft — context tokens processed
        //   per second before the first output token. 0 when nothing ever
        //   streamed (ttft 0).
        // - DECODE (output): completionTokens / (totalTime − ttft) —
        //   sustained generation speed over the OUTPUT phase only. Guarded
        //   against a zero-length phase (e.g. first token arrived at the
        //   final clock tick) so we never divide by ~0 and inflate speeds.
        const prefillTokensPerSec = ttft > 0 ? promptTokens / ttft : 0;
        const generationPhase = totalTime - ttft;
        const tokensPerSec = generationPhase > 0 ? completionTokens / generationPhase : 0;

        return {
            index,
            startTime: (runStart - benchStart) / 1000,
            ttft,
            totalTime,
            promptTokens,
            completionTokens,
            totalTokens,
            contentLength: content.length,
            prefillTokensPerSec,
            tokensPerSec
        };
    } catch (error: unknown) {
        // The run failed — record how far it got and the error message.
        // All token/speed fields stay 0 so summary stats skip this run.
        // An abort (cancellation) maps to the canonical 'cancelled' message
        // regardless of the transport's abort error wording.
        const totalTime = (clock() - runStart) / 1000;
        const message = signal?.aborted ? 'cancelled' : error instanceof Error ? error.message : String(error);
        return {
            index,
            startTime: (runStart - benchStart) / 1000,
            ttft,
            totalTime,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            contentLength: 0,
            prefillTokensPerSec: 0,
            tokensPerSec: 0,
            error: message
        };
    }
};

/**
 * Benchmarks a model by running the given prompt for N iterations.
 *
 * @param provider - The BenchProvider (model adapter) to measure.
 * @param options  - { prompt, iterations?, concurrency?, signal? } — iterations
 *                   defaults to 1; concurrency defaults to 1 (sequential);
 *                   `signal` aborts the bench (see BenchConfig.signal).
 * @param hooks    - Optional observability/determinism hooks (see BenchHooks).
 * @returns A BenchmarkReport with per-run measurements and the aggregated summary.
 *
 * @example
 *   const report = await runBench(
 *       { model: 'qwen3.8-27b', generate: (p, up) => client.stream(p, up) },
 *       { prompt: 'Write me 5000 words about yourself', iterations: 8, concurrency: 4 }
 *   );
 *   console.log(report.summary.throughput, 'tokens/s');
 */
export const runBench = async (
    provider: BenchProvider,
    options: Pick<BenchConfig, 'prompt'> & Partial<Pick<BenchConfig, 'iterations' | 'concurrency' | 'signal'>>,
    hooks: BenchHooks = {}
): Promise<BenchmarkReport> => {
    // Resolve + sanitize the configuration (force integers ≥ 1)
    const prompt = typeof options.prompt === 'string' ? options.prompt : '';
    const iterations = Math.max(1, Math.floor(numberEnsures(options.iterations) || 1));
    const concurrency = Math.max(1, Math.floor(numberEnsures(options.concurrency) || 1));
    // Cancellation signal — checked before every dispatched run and forwarded
    // to the provider so in-flight streaming requests abort immediately
    const signal = options.signal;

    // Bind the clock/timestamp sources (injectable for tests)
    const clock = hooks.clock ?? defaultClock;
    const now = hooks.now ?? defaultNow;

    // Stamp the bench start and immediately announce the run (useful for the UI)
    const benchStart = clock();
    hooks.onLog?.(`start ${iterations}× "${prompt.slice(0, 80)}" @ ${provider.model} (concurrency ${concurrency})`);

    // Reserved slots so run order in the final report matches the iteration index
    // even when concurrent runs finish out of order.
    const runs: BenchRun[] = new Array<BenchRun>(iterations);

    // Bounded-concurrency scheduler (single source of truth from @presource/core)
    const scheduler = taskCompletion(concurrency);

    for (let i = 0; i < iterations; i += 1) {
        // Enqueue each iteration; taskCompletion dispatches up to `concurrency`
        // of them in parallel and chains the rest as slots free up.
        scheduler.add(async () => {
            // CANCEL: a run whose turn arrived after the abort is recorded as
            // cancelled WITHOUT contacting the provider (the queue drains
            // instantly). In-flight runs abort through the provider signal.
            if (signal?.aborted) {
                const run = cancelledRun(i, benchStart, clock);
                runs[i] = run;
                hooks.onRun?.(run);
                hooks.onLog?.(`run ${i + 1}/${iterations} cancelled`);
                return;
            }
            // hooks.onStream + the signal ride along so the live in-flight
            // readouts fire and cancellation aborts the transport
            const run = await measureRun(provider, prompt, i, benchStart, clock, hooks.onStream, signal);
            runs[i] = run;
            // Per-run progress for live UI (e.g. dashboard console feed) —
            // BOTH speed metrics (input / output), matching the run record
            hooks.onRun?.(run);
            hooks.onLog?.(
                run.error === 'cancelled'
                    ? `run ${i + 1}/${iterations} cancelled`
                    : run.error
                      ? `run ${i + 1}/${iterations} FAILED (${run.error})`
                      : `run ${i + 1}/${iterations} done in ${run.totalTime.toFixed(2)}s ` +
                            `(${run.prefillTokensPerSec.toFixed(1)} tok/s prefill, ${run.tokensPerSec.toFixed(1)} tok/s decode)`
            );
        });
    }

    // Await the queue draining — every iteration (success or failure) is done
    await scheduler.completion();

    // Total wall time covers the entire bench (start → last run settled)
    const wallTime = (clock() - benchStart) / 1000;

    // Fold raw runs into the aggregated summary (failed runs excluded from stats)
    const summary = summarizeRuns(provider.model, runs, wallTime);

    // Final line carries BOTH speed averages (input / output)
    hooks.onLog?.(
        `finish ${provider.model}: ${summary.completedRuns}/${summary.runCount} ok, ` +
            `${summary.avgPrefillTokensPerSec.toFixed(1)} tok/s prefill avg, ${summary.throughput.toFixed(1)} tok/s decode avg`
    );

    return {
        model: provider.model,
        config: { prompt, iterations, concurrency },
        // Timestamp stamped through the injectable source for determinism
        createdAt: now(),
        wallTime,
        runs,
        summary
    };
};