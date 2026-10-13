// core/summarize.test.ts — exact-value assertions for the stats aggregator.
//
// The even-count fixture (4 runs) exists specifically to hit the median's
// average-of-two-adjacent branch; min/max/mean land on round numbers so this
// test stays a hard `toEqual` on the full summary object (no approximations).
import { describe, expect, it } from 'vitest';
import { summarizeRuns } from './summarize';
import type { BenchRun } from './types';

// Builds one run from its headline numbers (remaining fields filled coherently).
// `pps` is the run's prefill (input) speed — passed explicitly so the fixture
// means land on round numbers regardless of the ttft/prompt ratio.
const run = (ttft: number, time: number, tps: number, ct: number, pt: number, index: number, error?: string, pps = 100): BenchRun => ({
    index,
    startTime: 0,
    ttft,
    totalTime: time,
    promptTokens: pt,
    completionTokens: ct,
    totalTokens: pt + ct,
    contentLength: ct * 4,
    prefillTokensPerSec: pps,
    tokensPerSec: tps,
    ...(error ? { error } : {})
});

describe('summarizeRuns', () => {
    it('aggregates an even-count set of successful runs exactly', () => {
        // 4 runs: ttft 0.1/0.3/0.2/0.4 (median = (0.2+0.3)/2 = 0.25)
        // time 1/2/3/4, decode speeds 10/20/30/40, prefill speeds
        // 100/200/300/400, completions 100/200/300/400
        const runs = [
            run(0.1, 1, 10, 100, 50, 0, undefined, 100),
            run(0.3, 2, 20, 200, 50, 1, undefined, 200),
            run(0.2, 3, 30, 300, 50, 2, undefined, 300),
            run(0.4, 4, 40, 400, 50, 3, undefined, 400)
        ];

        expect(summarizeRuns('fixture/model', runs, 10)).toEqual({
            model: 'fixture/model',
            runCount: 4,
            completedRuns: 4,
            failedRuns: 0,
            successRate: 1,
            minTtft: 0.1,
            maxTtft: 0.4,
            avgTtft: 0.25, // (0.1 + 0.3 + 0.2 + 0.4) / 4
            medianTtft: 0.25, // even count: average of the 2nd and 3rd sorted values
            minTime: 1,
            maxTime: 4,
            avgTime: 2.5,
            throughput: 25, // mean of the decode speeds 10/20/30/40
            avgPrefillTokensPerSec: 250, // mean of the prefill speeds 100/200/300/400
            maxTokensPerSec: 40,
            avgCompletionTokens: 250,
            avgPromptTokens: 50,
            wallTime: 10
        });
    });

    it('degrades to zeros for a fully failed benchmark', () => {
        // Two attempts, both errored → only the counts carry information
        const runs = [run(0.1, 1, 10, 100, 50, 0, 'boom'), run(0.2, 2, 20, 200, 50, 1, 'boom')];

        expect(summarizeRuns('fixture/failed', runs, 5)).toEqual({
            model: 'fixture/failed',
            runCount: 2,
            completedRuns: 0,
            failedRuns: 2,
            successRate: 0,
            minTtft: 0,
            maxTtft: 0,
            avgTtft: 0,
            medianTtft: 0,
            minTime: 0,
            maxTime: 0,
            avgTime: 0,
            throughput: 0,
            avgPrefillTokensPerSec: 0,
            maxTokensPerSec: 0,
            avgCompletionTokens: 0,
            avgPromptTokens: 0,
            wallTime: 5
        });
    });

    it('returns an all-zero summary for an empty run list', () => {
        expect(summarizeRuns('fixture/empty', [], 0)).toEqual({
            model: 'fixture/empty',
            runCount: 0,
            completedRuns: 0,
            failedRuns: 0,
            successRate: 0,
            minTtft: 0,
            maxTtft: 0,
            avgTtft: 0,
            medianTtft: 0,
            minTime: 0,
            maxTime: 0,
            avgTime: 0,
            throughput: 0,
            avgPrefillTokensPerSec: 0,
            maxTokensPerSec: 0,
            avgCompletionTokens: 0,
            avgPromptTokens: 0,
            wallTime: 0
        });
    });

    it('mixes successful and failed runs: only successes feed the stats', () => {
        // 3 ok runs (ttft .1/.3/.5) + 1 failed → stats come from the 3 only
        const runs = [
            run(0.1, 1, 10, 100, 50, 0),
            run(0.3, 2, 20, 200, 50, 1, 'boom'), // failed: excluded from stats
            run(0.5, 3, 30, 300, 50, 2)
        ];

        expect(summarizeRuns('fixture/mixed', runs, 7)).toEqual({
            model: 'fixture/mixed',
            runCount: 3,
            completedRuns: 2,
            failedRuns: 1,
            successRate: 0.6666666666666666, // 2/3 (exact float)
            minTtft: 0.1,
            maxTtft: 0.5,
            avgTtft: 0.3, // (0.1 + 0.5) / 2
            medianTtft: 0.3, // two values → average of the pair
            minTime: 1,
            maxTime: 3,
            avgTime: 2,
            throughput: 20,
            avgPrefillTokensPerSec: 100, // only the 2 successful runs' prefill speeds (default 100)
            maxTokensPerSec: 30,
            avgCompletionTokens: 200,
            avgPromptTokens: 50,
            wallTime: 7
        });
    });
});