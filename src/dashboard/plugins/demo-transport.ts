// dashboard/plugins/demo-transport.ts — synthetic offline model adapters for
// the plugin fleet's `createProvider` injection point.
//
// The real plugin (model-bench.ts) binds createHttpProvider — the LAN
// transport. Stories/tests swap in THIS transport via
// createModelBenchPlugin's options or by building specs directly: it mimics
// a streaming chat completion (TTFT pause → word-by-word chunks → usage)
// without touching the network.
//
// Determinism: every delay routes through the injectable `sleep` — tests
// pass `async () => {}` so a full benchmark resolves instantly.
import { scriptPause } from '@presource/core';
import type { BenchGeneration, BenchProvider } from '../../core';
import type { DemoCatalogModel } from './demo-catalog';

// Default sleep: real delays so dev/storybook runs animate (scriptPause from
// @presource/core keeps delay handling idiomatic with the rest of the stack).
const SLEEP = async (ms: number) => {
    await scriptPause(ms);
};

/**
 * Builds a streaming BenchProvider that mimics the given latency profile.
 * Mirrors the old src/demo-provider.ts shape (TTFT pause → streamed words)
 * so the Run Timeline bars and the live Console animate exactly like a real
 * benchmark.
 *
 * @param profile - The simulated model characteristics (demo-catalog entry).
 * @param sleep   - Injectable delay primitive (tests pass an instant no-op).
 */
export const createDemoTransport = (
    profile: DemoCatalogModel,
    sleep: (ms: number) => Promise<void> = SLEEP
): BenchProvider => ({
    model: profile.id,
    generate: async (prompt: string, onUpdate?: (chunk: string) => void): Promise<BenchGeneration> => {
        // First-token latency: the model "thinks" before its first chunk
        await sleep(profile.ttftMs);

        const words: string[] = [];
        // Stream the completion one word at a time; the first emission lands
        // right after the TTFT pause (the runner treats chunk #1 as TTFT)
        for (let i = 0; i < profile.totalWords; i += 1) {
            const word = `w${i + 1}`;
            words.push(word);
            onUpdate?.(word);
            await sleep(profile.stepMs);
        }

        const content = words.join(' ');
        return {
            content,
            model: profile.id,
            usage: {
                // ~4 chars per word → estimate prompt as prompt-length/4
                promptTokens: Math.ceil(prompt.length / 4),
                completionTokens: words.length,
                totalTokens: Math.ceil(prompt.length / 4) + words.length
            }
        };
    }
});

/**
 * Runner wrapper that layers per-iteration failure injection on top of a
 * createDemoTransport stream: iteration N (1-indexed) matching the profile's
 * failIteration aborts with a synthetic upstream error. The runner in
 * ../../core captures the rejection as run.error — exactly the path a real
 * 503/timeout would take.
 */
export const createDemoBenchmark = (
    profile: DemoCatalogModel,
    sleep: (ms: number) => Promise<void> = SLEEP
) => {
    const base = createDemoTransport(profile, sleep);
    let currentRun = 0;

    return {
        provider: {
            ...base,
            model: profile.id,
            generate: (prompt: string, onUpdate?: (chunk: string) => void) => {
                currentRun += 1;
                // This is the designated flaky iteration → abort mid-stream
                if (profile.failIteration && currentRun === profile.failIteration) {
                    return Promise.reject(new Error('upstream 503: service unavailable (demo)'));
                }
                return base.generate(prompt, onUpdate);
            }
        },
        // Exposed for tests to know when the flaky iteration will fire
        nextRun: () => currentRun + 1
    };
};
