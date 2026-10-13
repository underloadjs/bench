// dashboard/scenarios/growing-context.test.ts — exact-value tests for the
// GROWING CONTEXT scenario (converted from the repo-root benchmark-server.ts
// context test, which was removed after the conversion).
//
// The critical behaviours under test:
//   - CONTINUATION: every turn resends the FULL accumulated history and
//     replays the previous assistant response — each request must be a pure
//     suffix append of the previous prompt+response (the prefix-reuse
//     contract). Asserted as EXACT message sequences.
//   - GROWTH: each conversation's context grows step by step toward the
//     final token budget, on a uniquely-seeded per-conversation document.
//   - PROGRESSIVE FEEDBACK: the entry counter advances per settled step and
//     the entry settles 'done' with a full report (one run per turn).
//   - CONCURRENCY: the plan's concurrency = conversations in flight.
//   - ABORT: a failed turn records the failure and marks the conversation's
//     remaining steps as skipped so the counter still settles.
//   - UNSUPPORTED: single-prompt-only providers settle the entry with an
//     error line instead of running.
import { describe, expect, it, vi } from 'vitest';
import { launchScenario } from '../framework';
import type { BenchScenarioPlugin } from '../framework';
import { growingContextScenario, buildGrowingConversations, CONTEXT_INSTRUCTION } from './growing-context';
import { cancelEntryRun, type BenchEntry } from '../context';
import type { BenchGeneration, BenchMessage, BenchProvider } from '../../core';

// ── Test doubles ─────────────────────────────────────────────────────────────

// Recorder actions — entries mirror into a plain array (newest first, like
// the real store) so assertions read like store state.
const recordActions = () => {
    const logs: Array<{ text: string; tone: string }> = [];
    const reports: Array<Record<string, unknown>> = [];
    const entries: BenchEntry[] = [];
    const actions = {
        pushLog: (text: string, tone = 'info') => logs.push({ text, tone }),
        addReport: (report: never) => reports.push(report as unknown as Record<string, unknown>),
        addEntry: (entry: BenchEntry) => {
            entries.unshift(entry);
        },
        updateEntry: (entryId: string, patch: Partial<BenchEntry>) => {
            const index = entries.findIndex((entry) => entry.id === entryId);
            entries[index] = { ...entries[index], ...patch };
        }
    };
    return { logs, reports, entries, actions };
};

// A conversation-capable stub provider: fixed 4-char content + fixed usage,
// recording EVERY messages array it was called with (the continuation log).
const conversationProvider = (calls: BenchMessage[][]): BenchProvider => ({
    model: 'ctx-model',
    generateConversation: async (messages: BenchMessage[]): Promise<BenchGeneration> => {
        calls.push(messages);
        return { content: 'abcd', model: 'ctx-model', usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } };
    }
});

// Small plan so the suite stays fast: 2 conversations... — NOTE: the case
// count is fixed at 8 (the original script's default); with steps=1 each
// conversation makes exactly ONE call, so 8 stub calls total.
const ONE_STEP_PLAN = { iterations: 1, concurrency: 1 };

// ── The generator ────────────────────────────────────────────────────────────

describe('buildGrowingConversations', () => {
    it('generates a uniquely-seeded document per conversation, split into disjoint step segments', () => {
        const conversations = buildGrowingConversations(2, 1000, 2);

        expect(conversations.map((conversation) => conversation.name)).toEqual(['case-1 → 1k ctx', 'case-2 → 1k ctx']);

        // Distinct documents per conversation (different seeds)
        expect(conversations[0].steps[0]).not.toBe(conversations[1].steps[0]);

        // FIRST turn carries the fixed instruction after its segment;
        // later turns are pure context growth
        expect(conversations[0].steps[0].endsWith(CONTEXT_INSTRUCTION)).toBe(true);
        expect(conversations[0].steps[1].includes(CONTEXT_INSTRUCTION)).toBe(false);

        // Growth: the second turn's segment is disjoint from the first
        const [firstSegment] = conversations[0].steps[0].split(`\n${CONTEXT_INSTRUCTION}`);
        expect(conversations[0].steps[1]).not.toContain(firstSegment);
        expect(conversations[0].steps[0].length + conversations[0].steps[1].length).toBeGreaterThanOrEqual(1000 * 4 - 64);
    });
});

// ── The scenario ─────────────────────────────────────────────────────────────

describe('growingContextScenario', () => {
    it('registers with the exact spec (8 conversations, 200k final tokens, sequential default)', () => {
        const scenario = growingContextScenario({} as never) as BenchScenarioPlugin;

        expect(scenario.id).toBe('growing-context');
        expect(scenario.name).toBe('Growing Context Scenario');
        expect(scenario.spec.label).toBe('Growing Context');
        expect(scenario.spec.icon).toBe('📚');
        expect(scenario.spec.iterations).toBe(8);
        expect(scenario.spec.concurrency).toBe(1);
        // The fixed summary instruction doubles as the display prompt
        expect(scenario.spec.prompt).toBe(CONTEXT_INSTRUCTION);
    });

    it('runs the context test with STRICT CONTINUATION: exact message sequences per conversation', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];

        await launchScenario({
            scenario: growingContextScenario({} as never) as BenchScenarioPlugin,
            modelId: 'ctx-model',
            modelLabel: 'ctx-model',
            provider: conversationProvider(calls),
            actions: recorder.actions,
            plan: { iterations: 2, concurrency: 1 },
            timing: {}
        });

        // 8 conversations × 2 steps = 16 streamed turns
        expect(calls.length).toBe(16);

        // CONTINUATION CONTRACT, asserted exactly on conversation 1:
        // call 1 — just the first segment + instruction
        const expectedFirstTurn: BenchMessage[] = [{ role: 'user', content: buildGrowingConversations(2, 200000)[0].steps[0] }];
        expect(calls[0]).toEqual(expectedFirstTurn);

        // call 2 — FULL history replay: first user turn + the previous
        // assistant response (replayed VERBATIM) + the next segment. Each
        // request is a pure suffix append of the previous prompt+response.
        const conversation = buildGrowingConversations(2, 200000)[0];
        expect(calls[1]).toEqual([
            { role: 'user', content: conversation.steps[0] },
            { role: 'assistant', content: 'abcd' },
            { role: 'user', content: conversation.steps[1] }
        ]);

        // Conversation 2 starts its OWN history (a different seeded document)
        const conversation2 = buildGrowingConversations(2, 200000)[1];
        expect(calls[2]).toEqual([{ role: 'user', content: conversation2.steps[0] }]);
        expect(calls[2][0].content).not.toBe(calls[0][0].content);
    });

    it('advances the entry progressively and settles it done with one run per turn', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];

        await launchScenario({
            scenario: growingContextScenario({} as never) as BenchScenarioPlugin,
            modelId: 'ctx-model',
            modelLabel: 'ctx-model',
            provider: conversationProvider(calls),
            actions: recorder.actions,
            plan: ONE_STEP_PLAN,
            timing: {}
        });

        const entry = recorder.entries[0];
        expect(entry.status).toBe('done');
        // 8 conversations × 1 step = 8 runs, all successful
        expect(entry.progress).toEqual({ completed: 8, failed: 0, total: 8 });
        expect(entry.report?.runs.length).toBe(8);
        expect(entry.report?.summary).toEqual(
            expect.objectContaining({ model: 'ctx-model', runCount: 8, completedRuns: 8, failedRuns: 0, successRate: 1 })
        );
        // Per-turn token accounting prefers the provider usage (10 / 4 / 14)
        expect(entry.report?.runs[0]).toEqual(
            expect.objectContaining({ promptTokens: 10, completionTokens: 4, totalTokens: 14, contentLength: 4 })
        );
        // THE TWO SPEED METRICS (exact relations on the run's own fields):
        // prefill = promptTokens / ttft (0 when nothing streamed), decode =
        // completionTokens / (totalTime − ttft) (0 when the phase is empty)
        const firstRun = entry.report?.runs[0];
        expect(firstRun).toBeTruthy();
        expect(firstRun!.prefillTokensPerSec).toBe(firstRun!.ttft > 0 ? firstRun!.promptTokens / firstRun!.ttft : 0);
        expect(firstRun!.tokensPerSec).toBe(
            firstRun!.totalTime - firstRun!.ttft > 0 ? firstRun!.completionTokens / (firstRun!.totalTime - firstRun!.ttft) : 0
        );
        // One log line per streamed turn (step counter + conversation name)
        expect(recorder.logs[0].text).toContain('step 1/1 — case-1 → 200k ctx:');
        expect(recorder.logs[7].text).toContain('step 1/1 — case-8 → 200k ctx:');
    });

    it('streams live per-turn readouts into the entry and clears each on settle', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        // Capture every `streaming` patch (per-turn live readouts + clears)
        const streamPatches: Array<BenchEntry['streaming']> = [];
        const baseUpdate = recorder.actions.updateEntry;
        recorder.actions.updateEntry = (entryId: string, patch: Partial<BenchEntry>) => {
            if ('streaming' in patch) streamPatches.push(patch.streaming);
            baseUpdate(entryId, patch);
        };

        // Conversation transport that STREAMS one 4-char chunk per turn —
        // each turn's chunk is its run's first → the publisher flushes it
        // immediately (the elapsed/rate fields are real-clock readings, so
        // only the deterministic fields are asserted exactly below)
        const streamingProvider: BenchProvider = {
            model: 'ctx-model',
            generateConversation: async (messages: BenchMessage[], onUpdate?: (chunk: string) => void): Promise<BenchGeneration> => {
                calls.push(messages);
                onUpdate?.('abcd');
                return { content: 'abcd', model: 'ctx-model', usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } };
            }
        };

        await launchScenario({
            scenario: growingContextScenario({} as never) as BenchScenarioPlugin,
            modelId: 'ctx-model',
            modelLabel: 'ctx-model',
            provider: streamingProvider,
            actions: recorder.actions,
            plan: ONE_STEP_PLAN,
            timing: {}
        });

        // 8 conversations × 1 step = 8 streamed turns. Patch sequence: the
        // run's reset (empty strip), then per turn its live push (4 chars →
        // 1 est. token) followed by the publish clear (the settled turn's
        // readout leaves the entry). The live rate is the DECODE speed —
        // streamed tokens over the post-TTFT phase — so the FIRST tick of
        // each turn reads exactly 0 (elapsed == ttft → empty phase, same
        // definition as the settled run) and later ticks go positive.
        // elapsed is a real-clock reading, hence only the deterministic
        // fields are asserted exactly:
        expect(streamPatches.length).toBe(17); // reset + 8 live pushes + 8 publish clears
        expect(streamPatches[0]).toEqual([]);
        const firstTick = (streamPatches[1] as NonNullable<BenchEntry['streaming']>)[0];
        expect(firstTick).toEqual(expect.objectContaining({ index: 0, chars: 4, tokens: 1, tokensPerSec: 0 }));
        expect(streamPatches[2]).toEqual([]);
        const secondTick = (streamPatches[3] as NonNullable<BenchEntry['streaming']>)[0];
        expect(secondTick).toEqual(expect.objectContaining({ index: 1, chars: 4, tokens: 1 }));
        // Every turn emits exactly ONE chunk → every tick is its turn's
        // first → decode phase empty → rate exactly 0
        expect(secondTick.tokensPerSec).toBe(0);
        const lastTick = (streamPatches[15] as NonNullable<BenchEntry['streaming']>)[0];
        expect(lastTick).toEqual(expect.objectContaining({ index: 7, chars: 4, tokens: 1 }));
        expect(streamPatches[16]).toEqual([]);
        // The entry settles with the streaming strip fully cleared
        expect(recorder.entries[0].streaming).toEqual([]);
    });

    it('aborts a conversation on a failed turn and marks the remaining steps skipped', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        let callCount = 0;
        // Every conversation's SECOND turn fails → each conversation aborts
        // with its remaining steps marked skipped
        const flakyProvider: BenchProvider = {
            model: 'ctx-model',
            generateConversation: async (messages: BenchMessage[]) => {
                calls.push(messages);
                callCount += 1;
                if (calls.length % 2 === 0) throw new Error('ctx overflow');
                return { content: 'ok', model: 'ctx-model' };
            }
        };

        await launchScenario({
            scenario: growingContextScenario({} as never) as BenchScenarioPlugin,
            modelId: 'ctx-model',
            modelLabel: 'ctx-model',
            provider: flakyProvider,
            actions: recorder.actions,
            plan: { iterations: 2, concurrency: 1 },
            timing: {}
        });

        const entry = recorder.entries[0];
        // Every conversation: 1 success + 1 failure — the counter settles
        expect(entry.progress).toEqual({ completed: 16, failed: 8, total: 16 });
        expect(entry.status).toBe('done');
        // With concurrency 1 the second turn of the FIRST conversation fails
        // and its remaining steps (none, steps=2) are skipped — conversation
        // 2 still runs (the failure does not take down the suite)
        expect(entry.report?.summary).toEqual(
            expect.objectContaining({ runCount: 16, completedRuns: 8, failedRuns: 8, successRate: 0.5 })
        );
        expect(recorder.logs.some((line) => line.tone === 'error' && line.text.includes('FAILED (ctx overflow)'))).toBe(true);
    });

    it('cancels the suite: the in-flight turn aborts and every remaining turn is recorded as cancelled', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        let hangStarted = false;
        // Turn 1 resolves normally; turn 2 hangs until its signal aborts
        // (mimics an in-flight streaming request)
        const cancelProvider: BenchProvider = {
            model: 'ctx-model',
            generateConversation: (
                messages: BenchMessage[],
                _onUpdate?: (chunk: string) => void,
                signal?: AbortSignal
            ): Promise<BenchGeneration> => {
                calls.push(messages);
                if (calls.length === 1) {
                    return Promise.resolve({ content: 'abcd', model: 'ctx-model', usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } });
                }
                hangStarted = true;
                return new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('aborted')));
                });
            }
        };

        const pending = launchScenario({
            scenario: growingContextScenario({} as never) as BenchScenarioPlugin,
            modelId: 'ctx-model',
            modelLabel: 'ctx-model',
            provider: cancelProvider,
            actions: recorder.actions,
            plan: { iterations: 2, concurrency: 1 },
            timing: {}
        });

        // Wait until conversation 1's SECOND turn is in flight, then cancel
        // through the real store registry (the entry card's CANCEL path)
        await vi.waitFor(() => expect(hangStarted).toBe(true));
        cancelEntryRun(recorder.entries[0].id);
        await pending;

        const entry = recorder.entries[0];
        expect(entry.status).toBe('done');
        // 8 conversations × 2 steps = 16 turns: only turn 1 completed
        expect(entry.progress).toEqual({ completed: 16, failed: 15, total: 16 });
        expect(entry.report?.summary).toEqual(expect.objectContaining({ runCount: 16, completedRuns: 1, failedRuns: 15 }));
        // Turn 2 (in-flight at cancel) AND every not-yet-started turn
        // (conversations 2-8 never began — sequential mode) read 'cancelled'
        expect(entry.report?.runs[1].error).toBe('cancelled');
        expect(entry.report?.runs[15].error).toBe('cancelled');
        expect(entry.report?.runs[0].error).toBeUndefined();
    });

    it('settles the entry with an error when the provider has no conversation transport', async () => {
        const recorder = recordActions();

        await launchScenario({
            scenario: growingContextScenario({} as never) as BenchScenarioPlugin,
            modelId: 'plain-model',
            modelLabel: 'plain-model',
            // Single-prompt-only provider (no generateConversation)
            provider: { model: 'plain-model', generate: async () => ({ content: 'x' }) },
            actions: recorder.actions,
            plan: { iterations: 2, concurrency: 1 },
            timing: {}
        });

        expect(recorder.entries[0].status).toBe('done');
        expect(recorder.entries[0].report).toBeNull();
        expect(recorder.logs).toEqual([
            { text: 'growing-context: plain-model has no conversation transport — skipped', tone: 'error' }
        ]);
    });
});
