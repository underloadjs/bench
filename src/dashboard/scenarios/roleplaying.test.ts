// dashboard/scenarios/roleplaying.test.ts — exact-value tests for the
// ROLEPLAYING scenario.
//
// The critical behaviours under test:
//   - PERSPECTIVE SWAP: the turn answering as person B is framed from A's
//     perspective (A's lines = `user`, B's = `assistant`), the next turn
//     swaps the labels — asserted as EXACT message sequences.
//   - CONTINUATION: every perspective replays the FULL prior dialogue, so
//     each request is a pure suffix append of the same perspective's previous
//     prompt+response (the prefix-reuse contract).
//   - CONTEXT STOP: the open-ended dialogue halts once a turn's request
//     carries ≥ 250k est. tokens (chars/4), or at the Iterations turn cap.
//   - PROGRESSIVE FEEDBACK: the entry counter grows per turn started and the
//     entry settles 'done' with one run per streamed turn.
//   - ABORT / FAILURE: a failed or cancelled turn ends the dialogue, the
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

// A conversation-capable stub provider: each turn answers with a marker
// derived from the message COUNT (so responses are unique per turn within a
// dialogue yet identical across parallel lanes — the assertions stay exact no
// matter how lanes interleave), recording EVERY messages array it was called
// with (the continuation log).
const conversationProvider = (calls: BenchMessage[][]): BenchProvider => ({
    model: 'rp-model',
    generateConversation: async (messages: BenchMessage[]): Promise<BenchGeneration> => {
        calls.push(messages);
        return { content: `as-${messages.length}`, model: 'rp-model' };
    }
});

// The ~ctx figure the scenario logs for a settled turn ("1,000,002 tok
// ctx") — the accumulated chars/4 estimate, thousands-separated
const reportedContextTokens = (logText: string): number =>
    Number(/([\d,]+) tok ctx/.exec(logText)?.[1]?.replace(/,/g, '') ?? NaN);

// The scenario's own stop rule, replayed over synthetic fixed-length replies
// (chars/4 with FRAMING_CHARS = 8 per replayed message) — the exact turn
// count the executor must produce for that reply size
const expectedTurnsUntilTarget = (
    systemAChars: number,
    systemBChars: number,
    replyChars: number,
    cap: number = Number.MAX_SAFE_INTEGER
): number => {
    let dialogueChars = 0;
    for (let turn = 0; ; turn += 1) {
        const systemChars = turn % 2 === 0 ? systemAChars : systemBChars;
        if (Math.ceil((systemChars + dialogueChars) / 4) >= ROLEPLAY_TARGET_TOKENS || turn + 1 >= cap) return turn + 1;
        dialogueChars += replyChars + 8;
    }
};

// ── The cast + the perspective builder ───────────────────────────────────────

describe('buildRoleplayCasts', () => {
    it('pairs the pool deterministically and sets both people up in each system prompt', () => {
        const casts = buildRoleplayCasts(2);

        expect(casts.map((cast) => cast.name)).toEqual(['duo-1 · Miriam & Devon', 'duo-2 · Ilya & Nour']);

        // Each perspective names BOTH people and carries the shared
        // instruction — the setup that gets either character going
        expect(casts[0].systemA).toContain('You are Miriam Holt');
        expect(casts[0].systemA).toContain('Devon Marsh');
        expect(casts[0].systemA).toContain(ROLEPLAY_INSTRUCTION);
        expect(casts[0].systemB).toContain('You are Devon Marsh');
        expect(casts[0].systemB).toContain('Miriam Holt');
        expect(casts[0].systemB).toContain(ROLEPLAY_INSTRUCTION);

        // Lane 2 gets the NEXT pair (distinct people, distinct prompts)
        expect(casts[1].systemA).toContain('You are Ilya Ferrand');
        expect(casts[1].systemA).not.toBe(casts[0].systemA);
    });
});

describe('perspectiveMessages', () => {
    it('labels the responder as assistant and the other person as user — and swaps on perspective', () => {
        const cast = buildRoleplayCasts(1)[0];
        const lines = [
            { speaker: 'A' as const, content: 'a1' },
            { speaker: 'B' as const, content: 'b1' }
        ];

        // B's perspective: B's lines = assistant, A's = user
        expect(perspectiveMessages(cast, lines, 'B')).toEqual([
            { role: 'system', content: cast.systemB },
            { role: 'user', content: 'a1' },
            { role: 'assistant', content: 'b1' }
        ]);
        // A's perspective SWAPS the labels (same lines, same order)
        expect(perspectiveMessages(cast, lines, 'A')).toEqual([
            { role: 'system', content: cast.systemA },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'b1' }
        ]);
        // An empty dialogue opens on the system setup alone
        expect(perspectiveMessages(cast, [], 'A')).toEqual([{ role: 'system', content: cast.systemA }]);
    });
});

// ── The scenario ─────────────────────────────────────────────────────────────

describe('roleplayingScenario', () => {
    it('registers with the exact spec (250k context target, 512 turn cap, one dialogue default)', () => {
        const scenario = roleplayingScenario({} as never) as BenchScenarioPlugin;

        expect(scenario.id).toBe('roleplaying');
        expect(scenario.name).toBe('Roleplaying Scenario');
        expect(scenario.spec.label).toBe('Roleplaying');
        expect(scenario.spec.icon).toBe('🎭');
        // Iterations is only the safety cap — the target stop drives the run
        expect(scenario.spec.iterations).toBe(512);
        expect(scenario.spec.concurrency).toBe(1);
        // THE CONTEXT TARGET: the dialogue stops at 250k est. tokens
        expect(ROLEPLAY_TARGET_TOKENS).toBe(250_000);
        // The shared instruction doubles as the display prompt
        expect(scenario.spec.prompt).toBe(ROLEPLAY_INSTRUCTION);
    });

    it('swaps perspectives every turn with STRICT CONTINUATION: exact message sequences', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];

        await launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'rp-model',
            modelLabel: 'rp-model',
            provider: conversationProvider(calls),
            actions: recorder.actions,
            // 4-turn cap × 1 dialogue → exactly 4 turns (A opens, they alternate)
            plan: { iterations: 4, concurrency: 1 },
            timing: {}
        });

        const [cast] = buildRoleplayCasts(1);
        expect(calls.length).toBe(4);

        // Turn 1 (responder A): person A's perspective setup ALONE opens it.
        // Turn 2 (responder B): A's perspective — A's line rides as `user`,
        // the model answers as B. Turn 3 SWAPS: A's own line becomes
        // `assistant`, B's line `user`. Turn 4 swaps back. Each request is
        // the same perspective's previous prompt+response plus new messages.
        expect(calls[0]).toEqual([{ role: 'system', content: cast.systemA }]);
        expect(calls[1]).toEqual([{ role: 'system', content: cast.systemB }, { role: 'user', content: 'as-1' }]);
        expect(calls[2]).toEqual([
            { role: 'system', content: cast.systemA },
            { role: 'assistant', content: 'as-1' },
            { role: 'user', content: 'as-2' }
        ]);
        expect(calls[3]).toEqual([
            { role: 'system', content: cast.systemB },
            { role: 'user', content: 'as-1' },
            { role: 'assistant', content: 'as-2' },
            { role: 'user', content: 'as-3' }
        ]);

        // The continuation contract stated structurally: each perspective's
        // later request EXTENDS its earlier one (pure suffix append)
        expect(calls[2].slice(0, calls[0].length)).toEqual(calls[0]);
        expect(calls[3].slice(0, calls[1].length)).toEqual(calls[1]);

        // The entry settles on the four taken turns (dynamic total == settled)
        expect(recorder.entries[0].progress).toEqual({ completed: 4, failed: 0, total: 4 });
        expect(recorder.entries[0].status).toBe('done');
    });

    it('stops the dialogue once the turn carries ~250k est. tokens of context', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        // ~10k est. tokens per turn → the target lands after a bounded,
        // exactly predictable number of turns
        const reply = 'x'.repeat(40_000);
        const verboseProvider: BenchProvider = {
            model: 'rp-model',
            generateConversation: async (messages: BenchMessage[]): Promise<BenchGeneration> => {
                calls.push(messages);
                return { content: reply, model: 'rp-model' };
            }
        };

        await launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'rp-model',
            modelLabel: 'rp-model',
            provider: verboseProvider,
            actions: recorder.actions,
            // The 512-turn cap is generous — the CONTEXT TARGET must bind first
            plan: { iterations: 512, concurrency: 1 },
            timing: {}
        });

        const [cast] = buildRoleplayCasts(1);
        const expected = expectedTurnsUntilTarget(cast.systemA.length, cast.systemB.length, reply.length);

        // The loop stopped AT the target: the final turn's request was the
        // first to carry ≥ 250k est. tokens
        expect(calls.length).toBe(expected);
        const turnLogs = recorder.logs.filter((line) => line.text.includes('tok ctx'));
        expect(turnLogs).toHaveLength(expected);
        expect(reportedContextTokens(turnLogs[expected - 1].text)).toBeGreaterThanOrEqual(ROLEPLAY_TARGET_TOKENS);
        if (expected > 1) {
            expect(reportedContextTokens(turnLogs[expected - 2].text)).toBeLessThan(ROLEPLAY_TARGET_TOKENS);
        }
        // The completion line lands, the entry settles on the taken turns
        expect(recorder.logs.some((line) => line.tone === 'success' && line.text.includes('roleplay complete'))).toBe(true);
        expect(recorder.entries[0].progress).toEqual({ completed: expected, failed: 0, total: expected });
        expect(recorder.entries[0].status).toBe('done');
        expect(recorder.entries[0].report?.runs).toHaveLength(expected);
    });

    it('honours the Iterations hard turn cap when the target is unreachable', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];

        await launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'rp-model',
            modelLabel: 'rp-model',
            provider: conversationProvider(calls),
            actions: recorder.actions,
            // Short replies → the 512-turn default would run forever; the
            // pinned 3-turn cap is what stops this dialogue
            plan: { iterations: 3, concurrency: 1 },
            timing: {}
        });

        expect(calls.length).toBe(3);
        expect(recorder.entries[0].progress).toEqual({ completed: 3, failed: 0, total: 3 });
    });

    it('runs one dialogue per lane: concurrency 2 roleplays two distinct casts independently', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];

        await launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'rp-model',
            modelLabel: 'rp-model',
            provider: conversationProvider(calls),
            actions: recorder.actions,
            // 2-turn cap × 2 dialogues = 4 turns total
            plan: { iterations: 2, concurrency: 2 },
            timing: {}
        });

        const [cast1, cast2] = buildRoleplayCasts(2);
        expect(calls.length).toBe(4);

        // Each dialogue owns its own two perspective requests — the lanes
        // never share a system prompt
        for (const cast of [cast1, cast2]) {
            const openings = calls.filter((messages) => messages[0]?.content === cast.systemA);
            const answers = calls.filter((messages) => messages[0]?.content === cast.systemB);
            expect(openings).toEqual([[{ role: 'system', content: cast.systemA }]]);
            expect(answers).toEqual([[{ role: 'system', content: cast.systemB }, { role: 'user', content: 'as-1' }]]);
        }
        // The two casts are DISTINCT pairs (nothing was silently shared)
        expect(new Set(calls.map((messages) => messages[0].content)).size).toBe(4);

        expect(recorder.entries[0].progress).toEqual({ completed: 4, failed: 0, total: 4 });
    });

    it('ends the dialogue on a failed turn and still settles the counter', async () => {
        const recorder = recordActions();
        const calls: BenchMessage[][] = [];
        // The SECOND turn (the first B-perspective request: system + A's
        // opening line) fails → the dialogue stops there
        const flakyProvider: BenchProvider = {
            model: 'rp-model',
            generateConversation: async (messages: BenchMessage[]) => {
                calls.push(messages);
                if (messages.length === 2) throw new Error('role drift');
                return { content: 'ok', model: 'rp-model' };
            }
        };

        await launchScenario({
            scenario: roleplayingScenario({} as never) as BenchScenarioPlugin,
            modelId: 'rp-model',
            modelLabel: 'rp-model',
            provider: flakyProvider,
            actions: recorder.actions,
            // A 4-turn cap — but the failure stops the dialogue at turn 2
            plan: { iterations: 4, concurrency: 1 },
            timing: {}
        });

        const entry = recorder.entries[0];
        // The open-ended loop records exactly the turns it started: 1 ok + 1 failed
        expect(calls.length).toBe(2);
        expect(entry.progress).toEqual({ completed: 2, failed: 1, total: 2 });
        expect(entry.status).toBe('done');
        expect(entry.report?.runs.map((run) => run.error)).toEqual([undefined, 'role drift']);
        expect(entry.report?.summary).toEqual(
            expect.objectContaining({ runCount: 2, completedRuns: 1, failedRuns: 1, successRate: 0.5 })
        );
        expect(recorder.logs.some((line) => line.tone === 'error' && line.text.includes('FAILED (role drift)'))).toBe(true);
    });

    it('cancels the dialogue: the in-flight turn aborts and no further turn is sent', async () => {
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
            // A 4-turn cap — cancel stops it after the two started turns
            plan: { iterations: 4, concurrency: 1 },
            timing: {}
        });

        // Wait until the dialogue's SECOND turn is in flight, then cancel
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
            plan: { iterations: 2, concurrency: 1 },
            timing: {}
        });

        expect(recorder.entries[0].status).toBe('done');
        expect(recorder.entries[0].report).toBeNull();
        expect(recorder.logs).toEqual([
            { text: 'roleplaying: plain-model has no conversation transport — skipped', tone: 'error' }
        ]);
    });
});
