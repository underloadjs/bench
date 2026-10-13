// core/runner.test.ts — engine execution tests with a DETERMINISTIC fake clock.
//
// The runner's clock + timestamp sources are injected (BenchHooks) so every
// timing lands on exact multiples of 40ms. The mock provider streams exactly
// one chunk then resolves, which pins the per-run clock call sequence:
//
//   sequential (iter i):  runStart → firstChunk(ttft) → resolve(end)
//   each call advances the fake clock by exactly 40ms.
//
// Those invariants are asserted as EXACT report objects below (toEqual on the
// full report for the clock-pinned scenarios).

import { describe, expect, it, vi } from 'vitest';
import { runBench } from './runner';
import type { BenchHooks, BenchProvider } from './types';

// Fresh fake clock: first read = 40ms, +40ms per subsequent read.
// Returning a positive value on call 1 keeps "time goes forward" honest (the
// bench start and the first run start sit 40ms apart, like a real bench).
const makeClock = () => {
    let t = 0;
    return () => (t += 40);
};

// Fixed timestamp source for report.createdAt
const fakeNow = () => '1970-01-01T00:00:00.000Z';

// Streaming mock: emits exactly one chunk (pins TTFT) then resolves with usage
const streamingProvider: BenchProvider = {
    model: 'test/model',
    generate: async (_prompt, onUpdate) => {
        onUpdate?.('chunk');
        return {
            content: 'abcd wxyz',
            usage: { promptTokens: 7, completionTokens: 9, totalTokens: 16 }
        };
    }
};

describe('runBench', () => {
    it('measures sequential iterations exactly (clock-pinned)', async () => {
        const onRun = vi.fn();
        // Expected clock sequence (step 40ms):
        //   40  bench start
        //   run i: start=80+120i, ttft=+40, end=+80  → 0.04s ttft, 0.08s total
        //   440 bench end → wall 0.4s
        const hooks: BenchHooks = { clock: makeClock(), now: fakeNow, onRun };

        const report = await runBench(streamingProvider, { prompt: 'hello', iterations: 3, concurrency: 1 }, hooks);

        expect(report.model).toBe('test/model');
        expect(report.config).toEqual({ prompt: 'hello', iterations: 3, concurrency: 1 });
        expect(report.createdAt).toBe('1970-01-01T00:00:00.000Z');
        expect(report.wallTime).toBe(0.4);
        expect(report.runs).toEqual([
            { index: 0, startTime: 0.04, ttft: 0.04, totalTime: 0.08, promptTokens: 7, completionTokens: 9, totalTokens: 16, contentLength: 9, prefillTokensPerSec: 175, tokensPerSec: 225 },
            { index: 1, startTime: 0.16, ttft: 0.04, totalTime: 0.08, promptTokens: 7, completionTokens: 9, totalTokens: 16, contentLength: 9, prefillTokensPerSec: 175, tokensPerSec: 225 },
            { index: 2, startTime: 0.28, ttft: 0.04, totalTime: 0.08, promptTokens: 7, completionTokens: 9, totalTokens: 16, contentLength: 9, prefillTokensPerSec: 175, tokensPerSec: 225 }
        ]);
        expect(report.summary).toEqual({
            model: 'test/model',
            runCount: 3,
            completedRuns: 3,
            failedRuns: 0,
            successRate: 1,
            minTtft: 0.04,
            maxTtft: 0.04,
            avgTtft: 0.04,
            medianTtft: 0.04,
            minTime: 0.08,
            maxTime: 0.08,
            avgTime: 0.08,
            throughput: 225,
            avgPrefillTokensPerSec: 175,
            maxTokensPerSec: 225,
            avgCompletionTokens: 9,
            avgPromptTokens: 7,
            wallTime: 0.4
        });
        // onRun fired once per iteration, in completion order
        expect(onRun).toHaveBeenCalledTimes(3);
        expect(onRun.mock.calls.map((c) => c[0].index)).toEqual([0, 1, 2]);
    });

    it('records provider failures without aborting the bench', async () => {
        // Throwing provider: no chunks, every run lands on the error path
        const failingProvider: BenchProvider = {
            model: 'test/failing',
            generate: async () => {
                throw new Error('boom');
            }
        };
        // Clock: 40 bench start; per run: start → catch(end) = 2 calls
        const hooks: BenchHooks = { clock: makeClock(), now: fakeNow };

        const report = await runBench(failingProvider, { prompt: 'hello', iterations: 2, concurrency: 1 }, hooks);

        // 40 start; run0: 80 → 120; run1: 160 → 200; end 240 → wall 0.2s
        expect(report.wallTime).toBe(0.2);
        expect(report.runs).toEqual([
            { index: 0, startTime: 0.04, ttft: 0, totalTime: 0.04, promptTokens: 0, completionTokens: 0, totalTokens: 0, contentLength: 0, prefillTokensPerSec: 0, tokensPerSec: 0, error: 'boom' },
            { index: 1, startTime: 0.12, ttft: 0, totalTime: 0.04, promptTokens: 0, completionTokens: 0, totalTokens: 0, contentLength: 0, prefillTokensPerSec: 0, tokensPerSec: 0, error: 'boom' }
        ]);
        // Total failure: every stat degrades to 0, successRate 0
        expect(report.summary).toEqual({
            model: 'test/failing',
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
            wallTime: 0.2
        });
    });

    it('runs 2 iterations concurrently (40ms-pinned interleaving)', async () => {
        // taskCompletion(2) starts BOTH tasks synchronously before any
        // microtask: clock order = start, s0, t0, s1, t1, e0, e1, end
        //   40 bench; 80 run0start; 120 run0 ttft; 160 run1start; 200 run1 ttft;
        //   240 run0 end (0.16s); 280 run1 end (0.12s); 320 wall (0.28s)
        const hooks: BenchHooks = { clock: makeClock(), now: fakeNow };

        const report = await runBench(streamingProvider, { prompt: 'hello', iterations: 2, concurrency: 2 }, hooks);

        expect(report.wallTime).toBe(0.28);
        expect(report.runs).toEqual([
            { index: 0, startTime: 0.04, ttft: 0.04, totalTime: 0.16, promptTokens: 7, completionTokens: 9, totalTokens: 16, contentLength: 9, prefillTokensPerSec: 175, tokensPerSec: 75 },
            { index: 1, startTime: 0.12, ttft: 0.04, totalTime: 0.12, promptTokens: 7, completionTokens: 9, totalTokens: 16, contentLength: 9, prefillTokensPerSec: 175, tokensPerSec: 112.50000000000001 }
        ]);
        expect(report.summary).toEqual({
            model: 'test/model',
            runCount: 2,
            completedRuns: 2,
            failedRuns: 0,
            successRate: 1,
            minTtft: 0.04,
            maxTtft: 0.04,
            avgTtft: 0.04,
            medianTtft: 0.04,
            minTime: 0.12,
            maxTime: 0.16,
            avgTime: 0.14,
            throughput: 93.75,
            avgPrefillTokensPerSec: 175,
            maxTokensPerSec: 112.50000000000001,
            avgCompletionTokens: 9,
            avgPromptTokens: 7,
            wallTime: 0.28
        });
    });

    it('estimates tokens from content length when usage is missing', async () => {
        // No usage object: prompt ≈ len/4 (ceil), completion ≈ len/4 (ceil)
        const bareProvider: BenchProvider = {
            model: 'test/bare',
            generate: async (_prompt, onUpdate) => {
                onUpdate?.('x');
                return { content: 'abcd' }; // 4 chars → 1 completion token
            }
        };
        const report = await runBench(bareProvider, { prompt: '12345678', iterations: 1 }, { clock: makeClock(), now: fakeNow });
        // prompt '12345678' (8 chars) → ceil(8/4) = 2 estimated tokens
        expect(report.runs[0].promptTokens).toBe(2);
        expect(report.runs[0].completionTokens).toBe(1);
        expect(report.runs[0].totalTokens).toBe(3);
    });

    it('fires onStream on every chunk with live in-flight readouts', async () => {
        const onStream = vi.fn();
        // Two-chunk provider: 'abcd' (4 chars) then 'efghijkl' (8 chars),
        // full content 12 chars. Clock sequence (step 40ms):
        //   40 bench start; 80 run start; 120 chunk1 (elapsed 0.04 = ttft);
        //   160 chunk2 (elapsed 0.08, phase 0.04); 200 run end; 240 wall
        const chunkedProvider: BenchProvider = {
            model: 'test/stream',
            generate: async (_prompt, onUpdate) => {
                onUpdate?.('abcd');
                onUpdate?.('efghijkl');
                return { content: 'abcdefghijkl' };
            }
        };

        const report = await runBench(chunkedProvider, { prompt: 'hello', iterations: 1 }, {
            clock: makeClock(),
            now: fakeNow,
            onStream
        });

        // One tick per chunk, exact in-flight readouts:
        //   chunk1: 4 chars → 1 est. token, elapsed == ttft → phase 0 → rate 0
        //   chunk2: 12 chars → 3 est. tokens, phase 0.04 → rate 3/0.04 = 75
        expect(onStream).toHaveBeenCalledTimes(2);
        expect(onStream.mock.calls[0][0]).toEqual({ index: 0, chars: 4, tokens: 1, elapsed: 0.04, tokensPerSec: 0, first: true });
        expect(onStream.mock.calls[1][0]).toEqual({ index: 0, chars: 12, tokens: 3, elapsed: 0.08, tokensPerSec: 75, first: false });

        // The final run math is unaffected by the streaming side-channel:
        // prompt 'hello' (5 chars) → 2 est. tokens; content 12 chars → 3
        // completion tokens; prefill = 2/0.04 = 50; phase 0.12 - 0.04 = 0.08
        // → 3/0.08 tok/s (floating-point: 37.50000000000001)
        expect(report.runs).toEqual([
            { index: 0, startTime: 0.04, ttft: 0.04, totalTime: 0.12, promptTokens: 2, completionTokens: 3, totalTokens: 5, contentLength: 12, prefillTokensPerSec: 50, tokensPerSec: 37.50000000000001 }
        ]);
    });

    it('cancels: in-flight run aborts, queued runs are skipped as cancelled', async () => {
        const controller = new AbortController();
        const onRun = vi.fn();
        let providerCalls = 0;
        // Provider whose generate hangs until its signal aborts (mimics an
        // in-flight streaming request) — only run 0 ever reaches it
        const hangingProvider: BenchProvider = {
            model: 'test/cancel',
            generate: (_prompt, _onUpdate, signal) =>
                new Promise<BenchGeneration>((_resolve, reject) => {
                    providerCalls += 1;
                    signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
                })
        };

        // Sequential queue: run 0 dispatches synchronously (its generate
        // registers the abort listener), runs 1-2 stay queued. Cancel while
        // run 0 is in flight.
        const pending = runBench(hangingProvider, { prompt: 'x', iterations: 3, concurrency: 1, signal: controller.signal }, { clock: makeClock(), now: fakeNow, onRun });
        controller.abort();
        const report = await pending;

        // Run 0: aborted mid-flight → the abort is mapped to the canonical
        // 'cancelled' message. Runs 1-2: the queue drained WITHOUT
        // contacting the provider → also 'cancelled'.
        expect(providerCalls).toBe(1);
        expect(report.runs.map((run) => run.error)).toEqual(['cancelled', 'cancelled', 'cancelled']);
        expect(onRun).toHaveBeenCalledTimes(3);
        // Cancelled runs stay out of the stats (all degrade to 0)
        expect(report.summary).toEqual(expect.objectContaining({ runCount: 3, completedRuns: 0, failedRuns: 3, successRate: 0 }));
    });

    it('counts reasoning tokens in the completion estimate when usage is missing', async () => {
        // Reasoning models stream chain-of-thought out-of-band (the transport
        // accumulates it into result.reasoning, see core/provider.ts) — the
        // estimate fallback must count it as OUTPUT. 'abcd' (4) + 'thinking'
        // (8) = 12 chars → ceil(12/4) = 3 completion tokens
        const reasoningProvider: BenchProvider = {
            model: 'test/reasoning',
            generate: async (_prompt, onUpdate) => {
                onUpdate?.('x');
                return { content: 'abcd', reasoning: 'thinking' };
            }
        };
        const report = await runBench(reasoningProvider, { prompt: 'hi', iterations: 1 }, { clock: makeClock(), now: fakeNow });
        // prompt 'hi' (2 chars) → 1 estimated token
        expect(report.runs[0].promptTokens).toBe(1);
        expect(report.runs[0].completionTokens).toBe(3);
        expect(report.runs[0].totalTokens).toBe(4);
    });
});

