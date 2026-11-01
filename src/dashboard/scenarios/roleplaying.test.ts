// dashboard/scenarios/roleplaying.test.ts — exact-value tests for the
// ROLEPLAYING scenario.
//
// The critical behaviours under test:
//   - ONE ITERATION = ONE COMPLETE CONVERSATION: the dialogue alternates
//     until the WHOLE chat log reaches 256k est. tokens — the panel's
//     Iterations counts conversations, not turns.
//   - PREPARED DATA ASKS A: the first request carries A's setup + person B's
//     opening line as the `user` message.
//   - PERSPECTIVE SWAP: every answer is restructured label-for-label
//     (assistant → user, user → assistant) so the OTHER person answers it —
//     B answers A's response, then back — asserted as EXACT message
//     sequences.
//   - CONTINUATION: each perspective replays the full chat log every turn, so
//     each request is a pure suffix append of the same perspective's previous
//     prompt+response (the prefix-reuse contract).
//   - CONTEXT STOP + SAFETY CAP + TURN LOGS: the conversation ends the
//     moment the chat-log estimate lands on the target (exact turn count
//     recomputed from the cast), a too-terse provider stops at the safety
//     cap, and the entry counter GROWS per turn started (open-ended total).
//   - ABORT / FAILURE: a failed or cancelled turn ends the conversation, the
//     counter still settles.
//   - UNSUPPORTED: single-prompt-only providers settle the entry with an
//     error line instead of running.
import { describe, expect, it, vi } from 'vitest';
import { launchScenario } from '../framework';
import type { BenchScenarioPlugin } from '../framework';
import {
    roleplayingScenario,
    buildRoleplayCasts,
    perspectiveMessages,
    ROLEPLAY_INSTRUCTION,
    ROLEPLAY_MAX_TURNS,
    ROLEPLAY_TARGET_TOKENS
} from './roleplaying';
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

// ~50k est. tokens per answer → a conversation lands on the 256k chat-log
// target after a handful of turns, keeping the exact-sequence assertions
// short while the stop count stays exactly computable
const REPLY_A = 'A'.repeat(200_000);
const REPLY_B = 'B'.repeat(200_000);

// A conversation-capable stub provider keyed to the cast: every request is
// recorded (the continuation log) and answered with a huge, speaker-tagged
// reply (which setup heads the request tells person A from person B) —
// deterministic no matter how parallel conversations interleave.
const bigReplyProvider = (calls: BenchMessage[][], cast: { systemA: string }): BenchProvider => ({
    model: 'rp-model',
    generateConversation: async (messages: BenchMessage[]): Promise<BenchGeneration> => {
        calls.push(messages);
        return { content: messages[0].content === cast.systemA ? REPLY_A : REPLY_B, model: 'rp-model' };
    }
});

// The scenario's own stop rule, replayed over fixed-length replies: the turn
// that first grows the WHOLE chat log (max setup + every replayed line,
// FRAMING_CHARS = 8 each) to the target — the conversation ends there
const expectedTurnsUntilTarget = (
    maxSetupChars: number,
    seedChars: number,
    replyChars: number,
    cap: number = ROLEPLAY_MAX_TURNS
): number => {
    let dialogueChars = seedChars + 8;
    for (let turn = 1; turn <= cap; turn += 1) {
        dialogueChars += replyChars + 8;
        if (Math.ceil((maxSetupChars + dialogueChars) / 4) >= ROLEPLAY_TARGET_TOKENS) return turn;
    }
    return cap;
};

// The chat-log figure the completion log carries ("259,952 est. tok")
const reportedChatLogTokens = (logText: string): number =>
    Number(/chat log reached ([\d,]+) est\. tok/.exec(logText)?.[1]?.replace(/,/g, '') ?? NaN);

// ── The cast + the perspective builder ───────────────────────────────────────

describe('buildRoleplayCasts', () => {
    it('pairs the pool deterministically, names both people in each setup, and prepares the opening data', () => {
        const casts = buildRoleplayCasts(2);

        expect(casts.map((cast) => cast.name)).toEqual(['duo-1 · Miriam & Devon', 'duo-2 · Ilya & Nour']);

        // Each setup names BOTH people and carries the shared instruction —
        // the data that gets either agent going on any topic
        expect(casts[0].systemA).toContain('You are Miriam Holt');
        expect(casts[0].systemA).toContain('Devon Marsh');
        expect(casts[0].systemA).toContain(ROLEPLAY_INSTRUCTION);
        expect(casts[0].systemB).toContain('You are Devon Marsh');
        expect(casts[0].systemB).toContain('Miriam Holt');
        expect(casts[0].systemB).toContain(ROLEPLAY_INSTRUCTION);

        // The PREPARED DATA that asks A — person B's opening line, rotated
        // per conversation (distinct conversations, distinct openers)
        expect(casts[0].seed.length).toBeGreaterThan(0);
        expect(casts[1].seed).not.toBe(casts[0].seed);

        // Conversation 2 gets the NEXT pair (distinct people, distinct setups)
        expect(casts[1].systemA).toContain('You are Ilya Ferrand');
        expect(casts[1].systemA).not.toBe(casts[0].systemA);
    });
});

describe('perspectiveMessages', () => {
    it('swaps every role label between perspectives — the restructure the swap is built on', () => {
        const cast = buildRoleplayCasts(1)[0];
        // Prepared opening (B's line = 'seed') plus A's answer
        const lines = [
            { speaker: 'B' as const, content: 'seed' },
            { speaker: 'A' as const, content: 'a1' }
        ];

        // A's perspective: B's lines = user (the prepared data ASKS A), A's = assistant
        expect(perspectiveMessages(cast, lines, 'A')).toEqual([
            { role: 'system', content: cast.systemA },
            { role: 'user', content: 'seed' },
            { role: 'assistant', content: 'a1' }
        ]);
        // B's perspective SWAPS every label (assistant → user, user →
        // assistant): A's answer becomes the user message B reacts to
        expect(perspectiveMessages(cast, lines, 'B')).toEqual([
            { role: 'system', content: cast.systemB },
            { role: 'assistant', content: 'seed' },
            { role: 'user', content: 'a1' }
        ]);
        // An empty chat log opens on the setup alone
        expect(perspectiveMessages(cast, [], 'A')).toEqual([{ role: 'system', content: cast.systemA }]);
    });
});

// ── The scenario ─────────────────────────────────────────────────────────────

describe('roleplayingScenario', () => {
    it('registers with the exact spec (256k chat-log target, one complete conversation default)', () => {
        const scenario = roleplayingScenario({} as never) as BenchScenarioPlugin;

        expect(scenario.id).toBe('roleplaying');
        expect(scenario.name).toBe('Roleplaying Scenario');
        expect(scenario.spec.label).toBe('Roleplaying');
        expect(scenario.spec.icon).toBe('🎭');
        // ONE iteration = ONE complete conversation up to the target
        expect(scenario.spec.iterations).toBe(1);
        expect(scenario.spec.concurrency).toBe(1);
        // THE CHAT-LOG TARGET: the conversation stops at 256k est. tokens
        expect(ROLEPLAY_TARGET_TOKENS).toBe(256_000);
        // The safety cap is a valve, never the stop that binds first
        expect(ROLEPLAY_MAX_TURNS).toBe(1000);
        // The shared instruction doubles as the display prompt
        expect(scenario.spec.prompt).toBe(ROLEPLAY_INSTRUCTION);
    });

    it('runs ONE conversation to the 256k chat-log target with the exact swapped message sequences', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        const [cast] = buildRoleplayCasts(1);

        await launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'rp-model',
            modelLabel: 'rp-model',
            provider: bigReplyProvider(calls, cast),
            actions: recorder.actions,
            // ONE conversation (one iteration) — turns run until the target
            plan: { iterations: 1, concurrency: 1 },
            timing: {}
        });

        // THE PREPARED DATA ASKS A, THEN EVERY TURN SWAPS THE LABELS so the
        // other person answers the last response:
        //   turn 1 (A's view): setup + B's opening line as `user` → A answers
        //   turn 2 (B's view): SWAPPED — A's answer is the `user` message B
        //     answers, the opening line becomes B's own `assistant` line
        //   turn 3 (A's view): swapped back, and so on
        expect(calls[0]).toEqual([
            { role: 'system', content: cast.systemA },
            { role: 'user', content: cast.seed }
        ]);
        expect(calls[1]).toEqual([
            { role: 'system', content: cast.systemB },
            { role: 'assistant', content: cast.seed },
            { role: 'user', content: REPLY_A }
        ]);
        expect(calls[2]).toEqual([
            { role: 'system', content: cast.systemA },
            { role: 'user', content: cast.seed },
            { role: 'assistant', content: REPLY_A },
            { role: 'user', content: REPLY_B }
        ]);
        expect(calls[3]).toEqual([
            { role: 'system', content: cast.systemB },
            { role: 'assistant', content: cast.seed },
            { role: 'user', content: REPLY_A },
            { role: 'assistant', content: REPLY_B },
            { role: 'user', content: REPLY_A }
        ]);

        // The CONTINUATION CONTRACT, stated structurally: each perspective's
        // later request EXTENDS its earlier one (pure suffix append)
        expect(calls[2].slice(0, calls[0].length)).toEqual(calls[0]);
        expect(calls[3].slice(0, calls[1].length)).toEqual(calls[1]);

        // THE CONTEXT STOP: the conversation ended exactly when the WHOLE
        // chat log (setup + every replayed line) first reached 256k est. tok
        const expected = expectedTurnsUntilTarget(
            Math.max(cast.systemA.length, cast.systemB.length),
            cast.seed.length,
            REPLY_A.length
        );
        expect(expected).toBeLessThan(ROLEPLAY_MAX_TURNS);
        expect(calls.length).toBe(expected);
        const completion = recorder.logs.filter((line) => line.text.includes('roleplay complete'));
        expect(completion).toHaveLength(1);
        expect(completion[0].tone).toBe('success');
        expect(reportedChatLogTokens(completion[0].text)).toBeGreaterThanOrEqual(ROLEPLAY_TARGET_TOKENS);

        // The entry settles on the turns actually taken (dynamic total ==
        // settled), one run per swapped turn
        const entry = recorder.entries[0];
        expect(entry.status).toBe('done');
        expect(entry.progress).toEqual({ completed: expected, failed: 0, total: expected });
        expect(entry.report?.runs).toHaveLength(expected);
        expect(entry.report?.config).toEqual({ prompt: ROLEPLAY_INSTRUCTION, iterations: 1, concurrency: 1 });
        // Token accounting: prompt = the replayed chat log (est.), completion
        // = the streamed answer (~chars/4)
        expect(entry.report?.runs[0]).toEqual(
            expect.objectContaining({
                promptTokens: Math.ceil((cast.systemA.length + cast.seed.length + 8) / 4),
                completionTokens: Math.ceil(REPLY_A.length / 4),
                contentLength: REPLY_A.length
            })
        );
    });

    it('Iterations counts CONVERSATIONS: 2 in flight run two complete dialogues with distinct casts', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        const [cast1, cast2] = buildRoleplayCasts(2);

        await launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'rp-model',
            modelLabel: 'rp-model',
            // Replies keyed off cast1.systemA only distinguish A/B within one
            // conversation; across the two lanes the setups differ, so lane
            // 2 answers everything with REPLY_B — its sequences below stay
            // exact (both lanes replay lane-2's own content consistently)
            provider: bigReplyProvider(calls, cast1),
            actions: recorder.actions,
            // TWO conversations (two iterations), both in flight
            plan: { iterations: 2, concurrency: 2 },
            timing: {}
        });

        // Each conversation owns its own openings: the prepared data asks ITS
        // person A, and its second turn swaps the labels for its person B
        for (const cast of [cast1, cast2]) {
            const openings = calls.filter((messages) => messages[0]?.content === cast.systemA);
            const answers = calls.filter((messages) => messages[0]?.content === cast.systemB);
            const replyA = cast === cast1 ? REPLY_A : REPLY_B;
            const replyB = REPLY_B;
            expect(openings[0]).toEqual([
                { role: 'system', content: cast.systemA },
                { role: 'user', content: cast.seed }
            ]);
            expect(answers[0]).toEqual([
                { role: 'system', content: cast.systemB },
                { role: 'assistant', content: cast.seed },
                { role: 'user', content: replyA }
            ]);
            // Both ran their OWN full conversation to the chat-log target
            const expected = expectedTurnsUntilTarget(
                Math.max(cast.systemA.length, cast.systemB.length),
                cast.seed.length,
                replyA.length
            );
            expect(openings.length + answers.length).toBe(expected);
        }

        // The two conversations never mixed chat logs: 4 distinct setups head
        // the 2 × expected requests, and the totals match
        expect(new Set(calls.map((messages) => messages[0].content)).size).toBe(4);
        const expectedTotal =
            expectedTurnsUntilTarget(Math.max(cast1.systemA.length, cast1.systemB.length), cast1.seed.length, REPLY_A.length) +
            expectedTurnsUntilTarget(Math.max(cast2.systemA.length, cast2.systemB.length), cast2.seed.length, REPLY_B.length);
        expect(calls.length).toBe(expectedTotal);
        expect(recorder.entries[0].progress).toEqual({ completed: expectedTotal, failed: 0, total: expectedTotal });
        // One completion line per conversation (two iterations finished)
        expect(recorder.logs.filter((line) => line.text.includes('roleplay complete'))).toHaveLength(2);
    });

    it('stops a too-terse provider at the safety cap, short of the target', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        // 1-char answers never grow the chat log to 256k in 1000 turns
        const terseProvider: BenchProvider = {
            model: 'rp-model',
            generateConversation: async (messages: BenchMessage[]): Promise<BenchGeneration> => {
                calls.push(messages);
                return { content: 'x', model: 'rp-model' };
            }
        };

        await launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'rp-model',
            modelLabel: 'rp-model',
            provider: terseProvider,
            actions: recorder.actions,
            plan: { iterations: 1, concurrency: 1 },
            timing: {}
        });

        expect(calls.length).toBe(ROLEPLAY_MAX_TURNS);
        expect(expectedTurnsUntilTarget(900, 160, 1)).toBe(ROLEPLAY_MAX_TURNS);
        const capLog = recorder.logs.filter((line) => line.text.includes('safety cap'));
        expect(capLog).toHaveLength(1);
        expect(capLog[0].tone).toBe('error');
        expect(recorder.entries[0].status).toBe('done');
        expect(recorder.entries[0].progress).toEqual({ completed: ROLEPLAY_MAX_TURNS, failed: 0, total: ROLEPLAY_MAX_TURNS });
        expect(recorder.entries[0].report?.runs).toHaveLength(ROLEPLAY_MAX_TURNS);
    });

    it('ends the conversation on a failed turn and still settles the counter', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        // The SECOND turn (B's first answer: setup + swapped opening + A's
        // reply = 3 messages) fails → the conversation stops there
        const flakyProvider: BenchProvider = {
            model: 'rp-model',
            generateConversation: async (messages: BenchMessage[]) => {
                calls.push(messages);
                if (messages.length === 3) throw new Error('role drift');
                return { content: 'ok', model: 'rp-model' };
            }
        };

        await launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'rp-model',
            modelLabel: 'rp-model',
            provider: flakyProvider,
            actions: recorder.actions,
            plan: { iterations: 1, concurrency: 1 },
            timing: {}
        });

        const entry = recorder.entries[0];
        // The open-ended conversation records exactly the turns it started:
        // 1 ok + 1 failed
        expect(calls.length).toBe(2);
        expect(entry.progress).toEqual({ completed: 2, failed: 1, total: 2 });
        expect(entry.status).toBe('done');
        expect(entry.report?.runs.map((run) => run.error)).toEqual([undefined, 'role drift']);
        expect(entry.report?.summary).toEqual(
            expect.objectContaining({ runCount: 2, completedRuns: 1, failedRuns: 1, successRate: 0.5 })
        );
        expect(recorder.logs.some((line) => line.tone === 'error' && line.text.includes('FAILED (role drift)'))).toBe(true);
    });

    it('cancels the conversation: the in-flight turn aborts and no further turn is sent', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        let hangStarted = false;
        // Turn 1 resolves normally; turn 2 hangs until its signal aborts
        const cancelProvider: BenchProvider = {
            model: 'rp-model',
            generateConversation: (
                messages: BenchMessage[],
                _onUpdate?: (chunk: string) => void,
                signal?: AbortSignal
            ): Promise<BenchGeneration> => {
                calls.push(messages);
                if (calls.length === 1) {
                    return Promise.resolve({ content: 'resp-1', model: 'rp-model' });
                }
                hangStarted = true;
                return new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('aborted')));
                });
            }
        };

        const pending = launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'rp-model',
            modelLabel: 'rp-model',
            provider: cancelProvider,
            actions: recorder.actions,
            plan: { iterations: 1, concurrency: 1 },
            timing: {}
        });

        // Wait until the conversation's SECOND turn is in flight, then cancel
        // through the real store registry (the entry card's CANCEL path)
        await vi.waitFor(() => expect(hangStarted).toBe(true));
        cancelEntryRun(recorder.entries[0].id);
        await pending;

        const entry = recorder.entries[0];
        expect(entry.status).toBe('done');
        // Only the two started turns are on record: turn 1 ok, turn 2 cancelled
        expect(entry.progress).toEqual({ completed: 2, failed: 1, total: 2 });
        expect(entry.report?.summary).toEqual(expect.objectContaining({ runCount: 2, completedRuns: 1, failedRuns: 1 }));
        expect(entry.report?.runs.map((run) => run.error)).toEqual([undefined, 'cancelled']);
        // Two requests only: the settled turn + the aborted in-flight one
        expect(calls.length).toBe(2);
    });

    it('settles the entry with an error when the provider has no conversation transport', async () => {
        const recorder = recordActions();

        await launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'plain-model',
            modelLabel: 'plain-model',
            // Single-prompt-only provider (no generateConversation)
            provider: { model: 'plain-model', generate: async () => ({ content: 'x' }) },
            actions: recorder.actions,
            plan: { iterations: 1, concurrency: 1 },
            timing: {}
        });

        expect(recorder.entries[0].status).toBe('done');
        expect(recorder.entries[0].report).toBeNull();
        expect(recorder.logs).toEqual([
            { text: 'roleplaying: plain-model has no conversation transport — skipped', tone: 'error' }
        ]);
    });
});
