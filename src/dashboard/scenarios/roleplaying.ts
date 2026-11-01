// dashboard/scenarios/roleplaying.ts — the ROLEPLAYING scenario.
//
// A two-person roleplay driven by ONE model across MANY turns: the bench sets
// up two people (a seeded cast pair per dialogue) and makes the SAME agent
// hold BOTH roles by SWAPPING PERSPECTIVES between turns:
//
//   - the turn that answers as person B is framed FROM PERSON A'S PERSPECTIVE:
//     A's lines ride as the `user` messages (the perspective owner "is him"),
//     B's lines as `assistant` — the model continues as B;
//   - the next turn swaps: the request is framed from B's perspective (B's
//     lines = `user`, A's = `assistant`) so the model answers as A;
//   - the system prompt per perspective sets both people up and carries the
//     shared ROLEPLAY_INSTRUCTION, which tells EACH character to start and
//     keep the conversation going on any topic — the dialogue never stalls.
//
// Each perspective replays the FULL prior dialogue every turn, so every
// request to a given perspective is a pure suffix append of its previous
// prompt+response — strict CONTINUATION per lane (the same prefix-reuse
// contract scenarios/growing-context.ts relies on, just alternating between
// two views of one conversation).
//
// The dialogue is OPEN ENDED: it stops once the turn's context estimate
// (~chars/4, the same heuristic growing-context uses) reaches
// ROLEPLAY_TARGET_TOKENS (250k est. tokens) — or at the panel's Iterations
// hard turn cap, or on a failed/cancelled turn. Concurrency = dialogues in
// flight, ONE cast pair each; through the panel the Concurrency select is
// consumed upstream as parallel lanes (framework/host.tsx), each roleplaying
// its own pair.
//
// Progress is reported PER TURN (each streamed turn is one recorded run) with
// a GROWING total (the turn count is unknown until the context target lands),
// and the entry settles with a full BenchmarkReport. Speed semantics mirror
// core BenchRun: PREFILL = promptTokens / ttft, DECODE = completionTokens /
// (totalTime − ttft). The scenario only executes against providers exposing
// `generateConversation` (createHttpProvider does); single-prompt-only
// providers are skipped with a console error.
//
// STANDALONE: imports only from the framework + core. Removing this file and
// its line in ./index.ts removes the roleplay test without touching anything
// else.
import { taskCompletion } from '@presource/core';
import { summarizeRuns, type BenchMessage, type BenchRun, type BenchmarkReport } from '../../core';
import type { BenchScenarioFactory, BenchScenarioHelper } from '../framework';
import { defineBenchScenario } from '../framework';
import type { BenchStreamState } from '../context';

// ── Scenario constants ───────────────────────────────────────────────────────

// Context size EACH dialogue stops at (est. tokens, ~chars/4): the loop keeps
// swapping perspectives and replaying the whole conversation until a turn's
// request carries this much context
export const ROLEPLAY_TARGET_TOKENS = 250_000;

// Shared conversation instruction — embedded in BOTH people's system prompts
// (so whichever role the model takes, it is told to get the dialogue going
// and keep it going, on any topic) and shown as the panel's display prompt
export const ROLEPLAY_INSTRUCTION =
    'Keep this conversation going. If it has not started yet, open it by greeting the other person ' +
    'and bringing up any topic you like. If it has, reply to what they just said, build on it, and ' +
    'steer the exchange forward with new details, questions and reactions. Write roughly 600-900 ' +
    'words of flowing in-character speech — never narrate, never speak for the other person, never ' +
    'leave the character.';

// Chat-template role framing per message (~"<|im_start|>role\n"), used only
// for the context-size estimate (mirrors scenarios/growing-context.ts)
const FRAMING_CHARS = 8;

// ── The cast ─────────────────────────────────────────────────────────────────
// One dialogue = one PAIR of people, assigned deterministically by dialogue
// index (consecutive pool entries) — lane i roleplays pair i % PAIR_COUNT.
// The profiles lean on the synthetic-context word pool's imagery (lanterns,
// harbours, basalt…) so the pairs read like the rest of the bench fixtures.
export type RoleplayPerson = {
    // Display name ("Miriam Holt")
    name: string;
    // One-line life situation woven into the system prompt
    role: string;
};

const ROLEPLAY_PEOPLE: RoleplayPerson[] = [
    { name: 'Miriam Holt', role: 'a retired lighthouse keeper who now restores antique clocks' },
    { name: 'Devon Marsh', role: 'a cartographer surveying a coastline that keeps shifting' },
    { name: 'Ilya Ferrand', role: 'a circuit designer who builds instruments from salvaged parts' },
    { name: 'Nour El-Amin', role: 'a harbour pilot who records weather lore in a leather notebook' },
    { name: 'Otto Bramble', role: 'a beekeeper and amateur bell-ringer in a hillside village' },
    { name: 'Sable Wynn', role: 'a long-haul cargo pilot ferrying supplies between islands' },
    { name: 'Casper Quill', role: 'an archivist preserving the letters of a drowned town' },
    { name: 'Tamsin Reed', role: 'a glassblower who models deep-sea creatures in blown glass' }
];

// The setup one perspective hands the model: who the model plays, who it is
// talking to, how the replayed messages read, plus the shared instruction
const roleplaySystemFor = (me: RoleplayPerson, other: RoleplayPerson) =>
    `You are ${me.name}, ${me.role}. You are talking with ${other.name}, ${other.role}. ` +
    `The user messages are ${other.name} speaking to you; the assistant messages are things ` +
    `you (${me.name}) already said. ${ROLEPLAY_INSTRUCTION}`;

// One dialogue plan: its cast pair and the two per-perspective system prompts
export type RoleplayCast = {
    // Display name ("duo-1 · Miriam & Devon")
    name: string;
    // The two people: personA opens the dialogue, personB answers first from
    // A's perspective (user = A's lines, assistant = B)
    personA: RoleplayPerson;
    personB: RoleplayPerson;
    // System prompt of the perspective that ANSWERS AS personA (and vice
    // versa for personB) — built from the pair, identical across turns
    systemA: string;
    systemB: string;
};

/**
 * Builds the dialogue cast list: `cases` pairs, pair = consecutive pool
 * entries rotated by dialogue index, so every lane gets a deterministic —
 * and, while lanes rotate past the pool, repeating — setup.
 */
export const buildRoleplayCasts = (cases: number): RoleplayCast[] => {
    const pairCount = ROLEPLAY_PEOPLE.length / 2;
    return Array.from({ length: cases }, (_, index) => {
        const pairIndex = (index % pairCount) * 2;
        const [personA, personB] = ROLEPLAY_PEOPLE.slice(pairIndex, pairIndex + 2);
        return {
            name: `duo-${index + 1} · ${personA.name.split(' ')[0]} & ${personB.name.split(' ')[0]}`,
            personA,
            personB,
            systemA: roleplaySystemFor(personA, personB),
            systemB: roleplaySystemFor(personB, personA)
        };
    });
};

// One spoken dialogue line: who said it (in CANONICAL terms — 'A' or 'B' of
// the cast), kept apart from the per-request role labels
type RoleplayLine = {
    speaker: 'A' | 'B';
    content: string;
};

/**
 * The PERSPECTIVE VIEW — the exact message list turn `responder` receives:
 * the responder's setup as `system`, then the WHOLE dialogue so far with the
 * responder's own lines as `assistant` and the other person's as `user`.
 * The other perspective SWAPS those labels. Both perspectives replay every
 * line every turn, so consecutive same-responder requests are pure suffix
 * appends (the continuation contract).
 */
export const perspectiveMessages = (cast: RoleplayCast, lines: RoleplayLine[], responder: 'A' | 'B'): BenchMessage[] => [
    { role: 'system', content: responder === 'A' ? cast.systemA : cast.systemB },
    ...lines.map((line) => ({
        role: line.speaker === responder ? ('assistant' as const) : ('user' as const),
        content: line.content
    }))
];

// ── Live streaming feedback (same contract as framework/scenario-kit.tsx) ─────
// The conversation transport fires per chunk; per-turn readouts accumulate
// the received text and land on the entry throttled (a turn's FIRST tick
// always pushes so the row appears without delay), and a turn's readout is
// removed the moment the turn settles (publish()).
const STREAM_PUSH_INTERVAL_MS = 150;

const createTurnStreamPublisher = (
    entryId: string,
    actions: BenchScenarioHelper['actions']
) => {
    // One live readout per in-flight turn (run index → latest tick)
    const streams = new Map<number, BenchStreamState>();
    let lastPush = 0;

    return {
        // Upsert the turn's live readout, then push unless the throttle says
        // otherwise (`first` ticks always push)
        record: (state: BenchStreamState, first = false) => {
            streams.set(state.index, state);
            const stamp = performance.now();
            if (!first && stamp - lastPush < STREAM_PUSH_INTERVAL_MS) return;
            lastPush = stamp;
            actions.updateEntry(entryId, {
                streaming: [...streams.values()].sort((a, b) => a.index - b.index)
            });
        },
        // The turn settled — its live readout leaves the entry's strip
        remove: (index: number) => {
            streams.delete(index);
        },
        // Current readouts, run-index order (folded into publish() patches)
        states: () => [...streams.values()].sort((a, b) => a.index - b.index)
    };
};

// ── The executor ─────────────────────────────────────────────────────────────
const executeRoleplaying = async (helper: BenchScenarioHelper) => {
    const { provider, actions, entryId, plan, signal } = helper;

    // The scenario NEEDS the conversation transport — the perspective swap is
    // the whole point and it is expressed as message role labels
    const streamConversation = provider.generateConversation;
    if (!streamConversation) {
        actions.pushLog(`roleplaying: ${provider.model} has no conversation transport — skipped`, 'error');
        actions.updateEntry(entryId, { status: 'done' });
        return;
    }

    // Plan mapping:
    //   Iterations  = the HARD TURN CAP per dialogue (safety valve — the
    //                 dialogue normally stops earlier, at the context target)
    //   Concurrency = dialogues in flight, ONE cast pair each
    // Through the panel dispatch the Concurrency select is consumed UPSTREAM
    // as parallel bench LANES (framework/host.tsx) — each lane roleplays its
    // own pair. Progress total GROWS with every turn taken: the turn count is
    // open ended (it stops at ~250k est. context), so no fixed denominator
    // exists up front.
    const maxTurns = plan.iterations;
    const inFlight = plan.concurrency;
    const casts = buildRoleplayCasts(inFlight);

    // Initial counter (launchScenario already created the entry 'running') —
    // total starts at 0 and grows per turn started
    actions.updateEntry(entryId, { progress: { completed: 0, failed: 0, total: 0 }, streaming: [] });

    // Live per-turn streaming readouts (the entry card's "N tok received"
    // rows) — same throttle/cleanup contract as the compiled helper
    const turnStreams = createTurnStreamPublisher(entryId, actions);

    // Slot-written runs (index = caseIndex * maxTurns + turnIndex) so the
    // report keeps a deterministic dialogue order no matter the completion
    // order; slots past a dialogue's stop point stay empty (filtered out)
    const runs: Array<BenchRun | undefined> = new Array(casts.length * maxTurns);
    let settled = 0;
    let failed = 0;
    let planned = 0;
    const benchStart = performance.now();

    // Publishes the settled-so-far slice as a partial report (progressive
    // panel updates — same contract as the compiled helper's onRun path)
    const publish = () => {
        const settledRuns = runs.filter((run): run is BenchRun => Boolean(run)).sort((a, b) => a.index - b.index);
        const partial: BenchmarkReport = {
            model: provider.model,
            config: { prompt: plan.prompt, iterations: settledRuns.length, concurrency: inFlight },
            createdAt: new Date().toISOString(),
            wallTime: 0,
            runs: settledRuns,
            summary: summarizeRuns(provider.model, settledRuns, 0)
        };
        actions.updateEntry(entryId, {
            progress: { completed: settled, failed, total: planned },
            streaming: turnStreams.states(),
            report: partial
        });
    };

    // A zero-field cancelled/failed turn record (the open-ended loop records
    // exactly the turns it started — there is no "remaining steps" to fill)
    const failedRun = (index: number, startTime: number, ttft: number, totalTime: number, error: string): BenchRun => ({
        index,
        startTime,
        ttft,
        totalTime,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        contentLength: 0,
        prefillTokensPerSec: 0,
        tokensPerSec: 0,
        error
    });

    // Runs ONE dialogue: alternate responders, each turn resending that
    // perspective's FULL accumulated view, then replaying the response into
    // the shared dialogue — strict continuation per perspective.
    const runDialogue = async (cast: RoleplayCast, caseIndex: number) => {
        const lines: RoleplayLine[] = [];
        // Context accounting: system prompt + every replayed line (+framing) —
        // both perspectives carry the whole dialogue, only the (small) system
        // prompt differs, so one shared counter drives the stop decision
        let dialogueChars = 0;

        for (let turn = 0; turn < maxTurns; turn += 1) {
            const responder: 'A' | 'B' = turn % 2 === 0 ? 'A' : 'B';
            const speaker = responder === 'A' ? cast.personA : cast.personB;
            const runIndex = caseIndex * maxTurns + turn;
            const runStart = performance.now();
            const startTime = (runStart - benchStart) / 1000;
            planned += 1;

            // CANCEL: the entry was cancelled before this turn started —
            // record THIS turn as cancelled and stop the dialogue without
            // contacting the provider
            if (signal.aborted) {
                runs[runIndex] = failedRun(runIndex, startTime, 0, 0, 'cancelled');
                settled += 1;
                failed += 1;
                publish();
                return;
            }

            // The perspective view: responder as assistant, the other as user
            const messages = perspectiveMessages(cast, lines, responder);
            const systemChars = responder === 'A' ? cast.systemA.length : cast.systemB.length;
            const contextTokens = Math.ceil((systemChars + dialogueChars) / 4);

            // First-chunk TTFT latch (mirrors the core runner)
            let ttft = 0;
            let firstChunk = true;
            // Characters received so far THIS turn — accumulated across
            // chunks and reported live through the turn-stream publisher
            let received = 0;
            // The streamed text so far this turn — carried by every live
            // readout so the entry card shows the words growing
            let turnText = '';

            try {
                const result = await streamConversation([...messages], (chunk) => {
                    // ONE clock read per chunk — mirrors the core runner
                    const stamp = performance.now();
                    if (firstChunk) {
                        ttft = (stamp - runStart) / 1000;
                        firstChunk = false;
                    }

                    // LIVE STREAMING FEEDBACK: accumulate the received text
                    // into this turn's readout ("N tok received · X tok/s"
                    // plus the streamed words while the turn generates).
                    // LIVE rate = DECODE speed — streamed tokens over the
                    // post-TTFT phase, guarded against a zero-length phase
                    // (the first chunk lands exactly AT ttft → rate reads 0).
                    received += chunk.length;
                    turnText += chunk;
                    const elapsed = (stamp - runStart) / 1000;
                    const streamedTokens = Math.ceil(received / 4);
                    const generationPhase = elapsed - ttft;
                    turnStreams.record(
                        {
                            index: runIndex,
                            chars: received,
                            tokens: streamedTokens,
                            text: turnText,
                            elapsed,
                            tokensPerSec: generationPhase > 0 ? streamedTokens / generationPhase : 0
                        },
                        received === chunk.length
                    );
                }, signal);
                const totalTime = (performance.now() - runStart) / 1000;
                const content = typeof result?.content === 'string' ? result.content : '';
                // Reasoning models stream chain-of-thought out-of-band (see
                // core/provider.ts) — those tokens ARE output for the estimate
                const reasoning = typeof result?.reasoning === 'string' ? result.reasoning : '';
                const usage = result?.usage;
                const promptTokens = usage?.promptTokens || contextTokens;
                const completionTokens = usage?.completionTokens || Math.ceil((content.length + reasoning.length) / 4);
                const totalTokens = usage?.totalTokens || promptTokens + completionTokens;
                // THE TWO SPEED METRICS (input / output measured separately,
                // same definitions as the core runner and growing-context)
                const prefillTokensPerSec = ttft > 0 ? promptTokens / ttft : 0;
                const generationPhase = totalTime - ttft;
                const tokensPerSec = generationPhase > 0 ? completionTokens / generationPhase : 0;

                runs[runIndex] = {
                    index: runIndex,
                    startTime,
                    ttft,
                    totalTime,
                    promptTokens,
                    completionTokens,
                    totalTokens,
                    contentLength: content.length,
                    prefillTokensPerSec,
                    tokensPerSec,
                    // The turn's complete output rides on the record (same
                    // contract as the core runner) so the UI can show it on
                    // demand; reasoning lands only when the model streamed one
                    content,
                    ...(reasoning ? { reasoning } : {})
                };

                // Replay this line into the dialogue — the NEXT request of
                // BOTH perspectives carries it (each labeled by perspective),
                // which is what makes turn s+2 a pure suffix append of s
                lines.push({ speaker: responder, content });
                dialogueChars += content.length + FRAMING_CHARS;

                actions.pushLog(
                    `turn ${turn + 1} — ${cast.name} as ${speaker.name}: ${contextTokens.toLocaleString('en-US')} tok ctx, ` +
                        `${totalTime.toFixed(2)}s total, ${ttft.toFixed(2)}s TTFT, ` +
                        `${prefillTokensPerSec.toFixed(1)} tok/s prefill, ${tokensPerSec.toFixed(1)} tok/s decode`,
                    'info'
                );
            } catch (error: unknown) {
                // A cancellation abort maps to the canonical 'cancelled'
                // message (the transport's abort error wording varies)
                const message = signal.aborted ? 'cancelled' : error instanceof Error ? error.message : String(error);
                const totalTime = (performance.now() - runStart) / 1000;
                // The failed turn's live readout (if it streamed any chunks)
                // leaves the strip — the run is settled
                turnStreams.remove(runIndex);
                runs[runIndex] = failedRun(runIndex, startTime, ttft, totalTime, message);
                actions.pushLog(
                    signal.aborted
                        ? `turn ${turn + 1} — ${cast.name} cancelled`
                        : `turn ${turn + 1} — ${cast.name} FAILED (${message})`,
                    signal.aborted ? 'info' : 'error'
                );
                // A failed turn breaks the dialogue's continuation chain —
                // the open-ended loop simply stops here
                settled += 1;
                failed += 1;
                publish();
                return;
            }

            settled += 1;
            // The settled turn's live readout leaves the strip
            turnStreams.remove(runIndex);
            publish();

            // THE CONTEXT TARGET: this turn's request already carried ~250k
            // est. tokens — the dialogue stops here
            if (contextTokens >= ROLEPLAY_TARGET_TOKENS) {
                actions.pushLog(
                    `${cast.name} reached ${contextTokens.toLocaleString('en-US')} est. tok context — roleplay complete`,
                    'success'
                );
                return;
            }
        }
    };

    // Bounded-concurrency execution of the dialogue suite (the same
    // taskCompletion scheduler the core runner uses)
    const scheduler = taskCompletion(inFlight);
    casts.forEach((cast, caseIndex) => {
        scheduler.add(async () => {
            await runDialogue(cast, caseIndex);
        });
    });
    await scheduler.completion();

    // Final report: only the turns actually taken (the open-ended loop leaves
    // its unused slots empty), real wall time, aggregated through the real
    // summarizer. Sorted by slot index so the order is deterministic.
    const finalRuns = runs.filter((run): run is BenchRun => Boolean(run)).sort((a, b) => a.index - b.index);
    const wallTime = (performance.now() - benchStart) / 1000;

    const report: BenchmarkReport = {
        model: provider.model,
        config: { prompt: plan.prompt, iterations: finalRuns.length, concurrency: inFlight },
        createdAt: new Date().toISOString(),
        wallTime,
        runs: finalRuns,
        summary: summarizeRuns(provider.model, finalRuns, wallTime)
    };
    actions.addReport(report);
    actions.updateEntry(entryId, { status: 'done', report });
};

// ── The scenario plugin ──────────────────────────────────────────────────────
// Spec: the shared instruction doubles as the display prompt (it IS what both
// people are told). Iterations defaults high (512) as a HARD TURN CAP — the
// dialogue stops at the ~250k est.-token context target long before it under
// normal verbosity — and concurrency default 1 (one dialogue).
export const roleplayingScenario: BenchScenarioFactory = () =>
    defineBenchScenario({
        id: 'roleplaying',
        name: 'Roleplaying Scenario',
        spec: {
            id: 'roleplaying',
            label: 'Roleplaying',
            icon: '🎭',
            description: `Two-person roleplay through ONE model with alternating perspectives (each turn swaps who is the assistant, strict continuation per view) until the context reaches ~${Math.round(ROLEPLAY_TARGET_TOKENS / 1000)}k est. tokens; Iterations = hard turn cap, Concurrency = dialogues in flight`,
            prompt: ROLEPLAY_INSTRUCTION,
            iterations: 512,
            concurrency: 1
        },
        // CUSTOM execute: the perspective-swapping roleplay (helper.run is
        // single-prompt and cannot express multi-turn conversations)
        execute: executeRoleplaying
    });
