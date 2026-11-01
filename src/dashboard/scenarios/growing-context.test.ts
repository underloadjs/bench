// dashboard/scenarios/growing-context.test.ts — exact-value tests for the
// GROWING CONTEXT scenario (converted from the repo-root benchmark-server.ts
// context test, which was removed after the conversion).
//
// The critical behaviours under test:
//   - CONTINUATION: every turn resends the FULL accumulated history and
//     replays the previous assistant response — each request must be a pure
//     suffix append of the previous prompt+response (the prefix-reuse
//     contract). Asserted as EXACT message sequences.
//   - GROWTH: the conversation's context grows step by step toward the
//     final 200k token budget, on a uniquely-seeded document.
//   - PLAN → CALLS: the panel's Iterations IS the request count of the bench
//     (one conversation, `iterations` growth steps) — no hidden conversation
//     fan-out, and Concurrency = conversations in flight (one conversation
//     each).
//   - PROGRESSIVE FEEDBACK: the entry counter advances per settled step and
//     the entry settles 'done' with a full report (one run per turn).
//   - ABORT: a failed turn records the failure and marks the conversation's
//     remaining steps as skipped so the counter still settles.
//   - UNSUPPORTED: single-prompt-only providers settle the entry with an
//     error line instead of running.
import { describe, expect, it, vi } from 'vitest';
import { launchScenario } from '../framework';
import type { BenchScenarioPlugin } from '../framework';
import {
    growingContextScenario,
    buildGrowingConversations,
    CONTEXT_INSTRUCTION,
    GROWING_CONTEXT_FINAL_TOKENS
} from './growing-context';
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

// The minimal plan: 1 growth step × 1 conversation → exactly ONE stub call.
// (Iterations IS the request count — the pre-fix behaviour of always building
// 8 conversations made this plan fire 8 calls, which is the glitch under test.)
const ONE_STEP_PLAN = { iterations: 1, concurrency: 1 };

// The ~ctx figure the scenario logs for a settled turn ("200,062 tok ctx") —
// the accumulated chars/4 estimate, thousands-separated
const reportedContextTokens = (logText: string): number =>
    Number(/([\d,]+) tok ctx/.exec(logText)?.[1]?.replace(/,/g, '') ?? NaN);

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
    it('registers with the exact spec (8 growth steps, 200k final tokens, one conversation default)', () => {
        const scenario = growingContextScenario({} as never) as BenchScenarioPlugin;

        expect(scenario.id).toBe('growing-context');
        expect(scenario.name).toBe('Growing Context Scenario');
        expect(scenario.spec.label).toBe('Growing Context');
        expect(scenario.spec.icon).toBe('📚');
        // 8 growth steps = 8 requests per bench, ONE conversation (concurrency 1)
        expect(scenario.spec.iterations).toBe(8);
        expect(scenario.spec.concurrency).toBe(1);
        // THE CONTEXT TARGET: the conversation grows to 200k est. tokens
        expect(GROWING_CONTEXT_FINAL_TOKENS).toBe(200_000);
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
            // 2 growth steps × 2 conversations (Concurrency = conversations in
            // flight, ONE conversation each) = 4 turns
            plan: { iterations: 2, concurrency: 2 },
            timing: {}
        });

        expect(calls.length).toBe(4);

        // CONTINUATION CONTRACT, asserted exactly on EVERY conversation:
        // its first call is just the first segment + the fixed instruction;
        // its second call is the FULL history replay — the previous assistant
        // response comes back VERBATIM, then the next segment is appended, so
        // each request is a pure suffix append of the previous prompt+response.
        for (const conversation of buildGrowingConversations(2, GROWING_CONTEXT_FINAL_TOKENS, 2)) {
            const turns = calls.filter((messages) => messages[0]?.content === conversation.steps[0]);
            expect(turns.length).toBe(2);

            const [firstTurn, secondTurn] = turns;
            expect(firstTurn).toEqual([{ role: 'user', content: conversation.steps[0] }]);
            expect(secondTurn).toEqual([
                { role: 'user', content: conversation.steps[0] },
                { role: 'assistant', content: 'abcd' },
                { role: 'user', content: conversation.steps[1] }
            ]);
        }

        // The conversations each grow their OWN seeded document (2 distinct
        // first turns across the 4 calls)
        expect(new Set(calls.map((messages) => messages[0].content)).size).toBe(2);
    });

    it('iterations 1 sends exactly ONE request at the full 200k context (no hidden fan-out)', async () => {
        // THE GLITCH UNDER TEST: the suite used to build GROWING_CONTEXT_CASES
        // (8) conversations no matter the plan, so "Iterations 1" fired EIGHT
        // calls per bench. The case count now follows Concurrency, so one
        // iteration is ONE request — and that request carries the WHOLE 200k
        // context (the document is not split when there is a single step).
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

        // ONE call, ONE user turn — nothing else was sent
        expect(calls.length).toBe(1);
        expect(calls[0]).toHaveLength(1);

        // THE 200k CONTEXT: the segment is the full finalTokens × 4 char
        // document, plus the fixed instruction the first turn always carries
        const segment = calls[0][0].content;
        expect(segment.endsWith(CONTEXT_INSTRUCTION)).toBe(true);
        expect(segment.length).toBe(GROWING_CONTEXT_FINAL_TOKENS * 4 + 1 + CONTEXT_INSTRUCTION.length);
        // The turn's own context reading lands on 200k (chars/4 estimate)
        expect(reportedContextTokens(recorder.logs[0].text)).toBeGreaterThanOrEqual(GROWING_CONTEXT_FINAL_TOKENS);

        // The entry settles on that single step
        expect(recorder.entries[0].progress).toEqual({ completed: 1, failed: 0, total: 1 });
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
        // 1 conversation × 1 step = ONE run, successful
        expect(entry.progress).toEqual({ completed: 1, failed: 0, total: 1 });
        expect(entry.report?.runs.length).toBe(1);
        expect(entry.report?.summary).toEqual(
            expect.objectContaining({ model: 'ctx-model', runCount: 1, completedRuns: 1, failedRuns: 0, successRate: 1 })
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
        // Exactly ONE log line for the ONE turn (step counter + conversation name)
        expect(recorder.logs).toHaveLength(1);
        expect(recorder.logs[0].text).toContain('step 1/1 — case-1 → 200k ctx:');
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

        // 1 conversation × 1 step = ONE streamed turn. Patch sequence: the
        // run's reset (empty strip), then the turn's live push (4 chars →
        // 1 est. token) followed by the publish clear (the settled turn's
        // readout leaves the entry). The live rate is the DECODE speed —
        // streamed tokens over the post-TTFT phase — so the FIRST tick of
        // the turn reads exactly 0 (elapsed == ttft → empty phase, same
        // definition as the settled run) and later ticks go positive.
        // elapsed is a real-clock reading, hence only the deterministic
        // fields are asserted exactly:
        expect(streamPatches.length).toBe(3); // reset + live push + publish clear
        expect(streamPatches[0]).toEqual([]);
        const firstTick = (streamPatches[1] as NonNullable<BenchEntry['streaming']>)[0];
        expect(firstTick).toEqual(expect.objectContaining({ index: 0, chars: 4, tokens: 1, tokensPerSec: 0 }));
        // The settled turn's readout leaves the strip
        expect(streamPatches[2]).toEqual([]);
        // The entry settles with the streaming strip fully cleared
        expect(recorder.entries[0].streaming).toEqual([]);
    });

    it('aborts a conversation on a failed turn and marks the remaining steps skipped', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        // EVERY conversation's second turn fails (a 3-message history is the
        // second turn — first user + replayed answer + new segment) → each
        // conversation aborts and its third step is recorded as skipped, while
        // the other conversation still runs its own turns
        const flakyProvider: BenchProvider = {
            model: 'ctx-model',
            generateConversation: async (messages: BenchMessage[]) => {
                calls.push(messages);
                if (messages.length === 3) throw new Error('ctx overflow');
                return { content: 'ok', model: 'ctx-model' };
            }
        };

        await launchScenario({
            scenario: growingContextScenario({} as never) as BenchScenarioPlugin,
            modelId: 'ctx-model',
            modelLabel: 'ctx-model',
            provider: flakyProvider,
            actions: recorder.actions,
            // 3 growth steps × 2 conversations = 6 planned runs
            plan: { iterations: 3, concurrency: 2 },
            timing: {}
        });

        const entry = recorder.entries[0];
        // Per conversation: 1 success + 1 failure + 1 skipped → the counter
        // still settles at completed == total
        expect(entry.progress).toEqual({ completed: 6, failed: 4, total: 6 });
        expect(entry.status).toBe('done');
        // Only the first two turns of each conversation ever reached the
        // provider — the skipped step is recorded, not sent
        expect(calls.length).toBe(4);
        // Conversation 1 owns slots 0-2, conversation 2 slots 3-5: BOTH chains
        // break the same way (the failure does not take down the suite)
        expect(entry.report?.runs.map((run) => run.error)).toEqual([
            undefined,
            'ctx overflow',
            'skipped: conversation aborted after step 2 failed',
            undefined,
            'ctx overflow',
            'skipped: conversation aborted after step 2 failed'
        ]);
        expect(entry.report?.summary).toEqual(
            expect.objectContaining({ runCount: 6, completedRuns: 2, failedRuns: 4, successRate: 2 / 6 })
        );
        expect(recorder.logs.some((line) => line.tone === 'error' && line.text.includes('FAILED (ctx overflow)'))).toBe(true);
    });

    it('cancels the conversation: the in-flight turn aborts and every remaining turn is recorded as cancelled', async () => {
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
            // ONE conversation of 4 growth steps
            plan: { iterations: 4, concurrency: 1 },
            timing: {}
        });

        // Wait until the conversation's SECOND turn is in flight, then cancel
        // through the real store registry (the entry card's CANCEL path)
        await vi.waitFor(() => expect(hangStarted).toBe(true));
        cancelEntryRun(recorder.entries[0].id);
        await pending;

        const entry = recorder.entries[0];
        expect(entry.status).toBe('done');
        // 4 planned turns: only turn 1 completed
        expect(entry.progress).toEqual({ completed: 4, failed: 3, total: 4 });
        expect(entry.report?.summary).toEqual(expect.objectContaining({ runCount: 4, completedRuns: 1, failedRuns: 3 }));
        // Turn 2 (in-flight at cancel) AND every later turn of the conversation
        // read 'cancelled' — the chain stops without contacting the provider
        expect(entry.report?.runs.map((run) => run.error)).toEqual([
            undefined,
            'cancelled',
            'cancelled',
            'cancelled'
        ]);
        // Two requests only: the settled turn + the aborted in-flight one
        expect(calls.length).toBe(2);
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
