// core/summarize.ts — pure statistical aggregation for benchmark runs.
//
// summarizeRuns() folds a list of raw BenchRun measurements into a BenchSummary.
// It is PURE (no I/O, no globals): given the same runs it always returns the
// same numbers, which is what makes the engine unit-testable with exact values.
//
// Conventions:
// - Failed runs (run.error set) are counted in runCount/failedRuns but EXCLUDED
//   from latency/speed/tokennumber statistics — measuring a failed run's "speed"
//   would skew the aggregate (a 404 run has 0 tokens in 0.3s = "fast").
// - Every field degrades to 0 for empty/total-failure input (never NaN) so the
//   dashboard can render degenerate reports.

import { arrayEach, numberEnsures } from '@presource/core';
import type { BenchRun, BenchSummary } from './types';

// Arithmetic mean of a number list; returns 0 for an empty list (no NaN leaks).
const mean = (values: number[]): number => {
    if (values.length === 0) return 0;
    let sum = 0;
    // arrayEach keeps iteration idiomatic with the rest of @presource/core
    arrayEach(values, ({ value }) => {
        sum += value;
    });
    return sum / values.length;
};

// Median of a number list (even count → average of the two middle values).
// The input array is never mutated — a sorted copy is used.
const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    // numberEnsures guards against non-number entries sneaking in
    const sorted = [...values].map((v) => numberEnsures(v)).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    // Odd count: the middle element IS the median
    if (sorted.length % 2 === 1) return sorted[mid];
    // Even count: average of the two central values
    return (sorted[mid - 1] + sorted[mid]) / 2;
};

// Extremum helper over a list (0 for empty), with `dir` selecting min or max.
// Uses arrayEach so the helper shares @presource/core iteration semantics.
const extremum = (values: number[], dir: 'min' | 'max'): number => {
    if (values.length === 0) return 0;
    let result = dir === 'min' ? Infinity : -Infinity;
    arrayEach(values, ({ value }) => {
        const v = numberEnsures(value);
        if (dir === 'min' ? v < result : v > result) result = v;
    });
    return result;
};

/**
 * Aggregates raw benchmark runs into a per-model summary.
 *
 * @param model  - Model identifier copied onto the summary.
 * @param runs   - Raw per-iteration measurements (any order; stats are order-independent
 *                 except that runs are assumed complete, i.e. already captured by the runner).
 * @param wallTime - Total wall time of the whole benchmark, seconds. Passed in by the
 *                   runner because it's measured outside the per-run sampling window.
 * @returns A fully-populated BenchSummary (see types.ts for field semantics).
 */
export const summarizeRuns = (model: string, runs: BenchRun[], wallTime: number): BenchSummary => {
    // Split into successful vs failed — failed runs only influence the counts
    const completed: BenchRun[] = [];
    let failed = 0;
    arrayEach(runs, ({ value: run }) => {
        if (run.error) {
            failed += 1;
        } else {
            completed.push(run);
        }
    });

    const runCount = runs.length;

    // Collect the metric series across successful runs for each stat below
    const ttfts = completed.map((r) => r.ttft);
    const times = completed.map((r) => r.totalTime);
    // The two speed metrics are aggregated SEPARATELY (input vs output):
    // decode speeds and prefill speeds never mix into one mean
    const decodeSpeeds = completed.map((r) => r.tokensPerSec);
    const prefillSpeeds = completed.map((r) => r.prefillTokensPerSec);
    const completionTokens = completed.map((r) => r.completionTokens);
    const promptTokens = completed.map((r) => r.promptTokens);

    return {
        model,
        runCount,
        completedRuns: completed.length,
        failedRuns: failed,
        // Guard the division: no runs at all → 0 rather than 0/0
        successRate: runCount === 0 ? 0 : completed.length / runCount,
        minTtft: extremum(ttfts, 'min'),
        maxTtft: extremum(ttfts, 'max'),
        avgTtft: mean(ttfts),
        medianTtft: median(ttfts),
        minTime: extremum(times, 'min'),
        maxTime: extremum(times, 'max'),
        avgTime: mean(times),
        // throughput == mean of per-run DECODE speeds (output metric —
        // completion tokens over the post-TTFT phase; not totalTokens/
        // totalTime, which would over-weight slow runs during concurrent
        // execution). Prefill (input) speed is aggregated separately below.
        throughput: mean(decodeSpeeds),
        avgPrefillTokensPerSec: mean(prefillSpeeds),
        maxTokensPerSec: extremum(decodeSpeeds, 'max'),
        avgCompletionTokens: mean(completionTokens),
        avgPromptTokens: mean(promptTokens),
        // numberEnsures ensures wallTime always lands as a number in the summary
        wallTime: numberEnsures(wallTime)
    };
};