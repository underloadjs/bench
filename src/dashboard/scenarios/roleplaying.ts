// dashboard/scenarios/roleplaying.ts — the ROLEPLAYING scenario.
//
// ONE ITERATION = ONE COMPLETE ROLEPLAY CONVERSATION: the bench defines two
// named people (a seeded cast pair per conversation), prepares the opening
// data that ASKS PERSON A, and then drives the dialogue back and forth until
// the ENTIRE CHAT LOG reaches ROLEPLAY_TARGET_TOKENS (256k est. tokens):
//
//   - the first request carries person A's setup + the prepared opening line:
//     the model answers AS A;
//   - A's answer is then RESTRUCTURED for B — every message's role label
//     SWAPS (assistant → user, user → assistant): A's answer rides as the
//     `user` message B reacts to, B's own lines as `assistant`, and the
//     model answers AS B (i.e. B is answering A's response);
//   - the next turn swaps back (A's view: user = B's lines, assistant = A's
//     own lines), and so on — the SAME model holds both agents, alternating
//     perspective every turn;
//   - each perspective replays the WHOLE chat log every turn, so consecutive
//     same-perspective requests are pure suffix appends of the previous
//     prompt+response — strict CONTINUATION per view (the same prefix-reuse
//     contract scenarios/growing-context.ts relies on);
//   - the shared ROLEPLAY_INSTRUCTION rides in BOTH setups and tells each
//     character to get the conversation going (greet, raise any topic, keep
//     answering and steering) — the dialogue never stalls.
//
// Stopping is on the CHAT LOG SIZE: after every replayed answer the estimate
// (~chars/4 + per-message framing, the same heuristic growing-context uses)
// is checked against the 256k target, and the conversation ends the moment it
// reaches it. A large internal turn cap (ROLEPLAY_MAX_TURNS) only guards
// pathologically terse providers from looping forever.
//
// Plan mapping — Iterations = WHOLE roleplay conversations this entry runs
// (each one grows its own chat log to ~256k), Concurrency = conversations in
// flight; through the panel the Concurrency select is consumed upstream as
// parallel lanes (framework/host.tsx), each lane roleplaying its own pair.
// Progress is reported PER TURN (each streamed turn is one recorded run)
// with a GROWING total — a conversation's turn count is unknown until the
// chat log lands on the target — and each entry settles with a full
// BenchmarkReport. Speed semantics mirror core BenchRun: PREFILL =
// promptTokens / ttft, DECODE = completionTokens / (totalTime − ttft). The
// scenario only executes against providers exposing `generateConversation`
// (createHttpProvider does); single-prompt-only providers are skipped with a
// console error.
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

// The CHAT LOG SIZE one iteration (one conversation) stops at, est. tokens
// (~chars/4): the dialogue swaps perspectives until the whole log reaches
// this, then the conversation is COMPLETE — that whole run is one Iteration
export const ROLEPLAY_TARGET_TOKENS = 256_000;

// Safety valve ONLY: a conversation could otherwise run forever against a
// pathologically terse provider that never grows the log toward the target.
// It never binds under normal verbosity (600-900-word turns land on 256k in
// roughly 200 turns)
export const ROLEPLAY_MAX_TURNS = 1000;

// Shared conversation instruction — embedded in BOTH people's setups (so
// whichever agent the model takes, it is told to get the dialogue going and
// keep it going, on any topic) and shown as the panel's display prompt
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
// One conversation = one PAIR of named people, assigned deterministically by
// conversation index (consecutive pool entries) + one PREPARED OPENING LINE
// (the data that asks A: person B's opening message, rotated by index). The
// profiles lean on the synthetic-context word pool's imagery (lanterns,
// harbours, basalt…) so the pairs read like the rest of the bench fixtures.
export type RoleplayPerson = {
    // Display name ("Miriam Holt")
    name: string;
    // One-line life situation woven into the setup
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

// The prepared opening data — person B's greeting to A. It is the `user`
// message that ASKS A to speak on the very first turn, and after the
// perspective swap it rides back as B's own (`assistant`) line.
const ROLEPLAY_OPENINGS: string[] = [
    'Come, sit down — I have been turning something over in my head all week and you are the first person I want to talk it through with. What has been keeping you busy lately?',
    'I walked past the old harbour this morning and thought of you straight away. Tell me what you have been building, fixing or chasing since we last spoke.',
    'Before the light goes, walk me through that idea you would not stop talking about. I brought my notebook, and I fully intend to argue with you.',
    'I woke before dawn with a question on my mind, and here you are. Start anywhere you like — what has been at the centre of your thoughts lately?'
];

// The setup one perspective hands the model: who the model plays, who it is
// talking to, how the replayed messages read, plus the shared instruction
const roleplaySetupFor = (me: RoleplayPerson, other: RoleplayPerson) =>
    `You are ${me.name}, ${me.role}. You are talking with ${other.name}, ${other.role}. ` +
    `The user messages are ${other.name} speaking to you; the assistant messages are things ` +
    `you (${me.name}) already said. ${ROLEPLAY_INSTRUCTION}`;

// One conversation plan: its named pair, the prepared opening data, and the
// two per-perspective setups
export type RoleplayCast = {
    // Display name ("duo-1 · Miriam & Devon")
    name: string;
    // Person A answers the prepared opening; person B (whose line the opening
    // is) answers A's response next, then they alternate
    personA: RoleplayPerson;
    personB: RoleplayPerson;
    // The PREPARED DATA that asks A — person B's opening message
    seed: string;
    // Setup of the perspective that ANSWERS AS personA (and vice versa for
    // personB) — built from the pair, identical across the conversation
    systemA: string;
    systemB: string;
};

/**
 * Builds the conversation cast list: `cases` pairs, pair = consecutive pool
 * entries rotated by conversation index and opening line rotated alongside —
 * every conversation is a deterministic, distinct setup.
 */
export const buildRoleplayCasts = (cases: number): RoleplayCast[] => {
    const pairCount = ROLEPLAY_PEOPLE.length / 2;
    return Array.from({ length: cases }, (_, index) => {
        const [personA, personB] = ROLEPLAY_PEOPLE.slice((index % pairCount) * 2, (index % pairCount) * 2 + 2);
        return {
            name: `duo-${index + 1} · ${personA.name.split(' ')[0]} & ${personB.name.split(' ')[0]}`,
            personA,
            personB,
            seed: ROLEPLAY_OPENINGS[index % ROLEPLAY_OPENINGS.length],
            systemA: roleplaySetupFor(personA, personB),
            systemB: roleplaySetupFor(personB, personA)
        };
    });
};

// One chat-log line: who said it in CANONICAL terms ('A'/'B' of the cast),
// kept apart from the per-request role labels
type RoleplayLine = {
    speaker: 'A' | 'B';
    content: string;
};

/**
 * The PERSPECTIVE VIEW — the exact message list turn `responder` receives:
 * the responder's setup as `system`, then the WHOLE chat log so far with the
 * responder's own lines as `assistant` and the other person's as `user`.
 * The other perspective SWAPS those labels (assistant → user, user →
 * assistant). Both perspectives replay every line every turn, so consecutive
 * same-responder requests are pure suffix appends (the continuation
 * contract).
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
    //   Iterations  = WHOLE roleplay conversations this entry runs — ONE
    //                 iteration = one complete back-and-forth chat log grown
    //                 to ~256k est. tokens (however many turns that takes)
    //   Concurrency = conversations in flight, ONE named cast pair each
    // Progress total GROWS with every turn started: the turns per conversation
    // are open ended (they stop when the chat log lands on the target), so no
    // fixed denominator exists up front.
    const dialogues = plan.iterations;
    const inFlight = plan.concurrency;
    const casts = buildRoleplayCasts(dialogues);

    // Initial counter (launchScenario already created the entry 'running') —
    // total starts at 0 and grows per turn started
    actions.updateEntry(entryId, { progress: { completed: 0, failed: 0, total: 0 }, streaming: [] });

    // Live per-turn streaming readouts (the entry card's "N tok received"
    // rows) — same throttle/cleanup contract as the compiled helper
    const turnStreams = createTurnStreamPublisher(entryId, actions);

    // Slot-written runs (index = caseIndex * ROLEPLAY_MAX_TURNS + turnIndex)
    // so the report keeps a deterministic conversation order no matter the
    // completion order; slots past a conversation's stop point stay empty
    const runs: Array<BenchRun | undefined> = new Array(casts.length * ROLEPLAY_MAX_TURNS);
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
            config: { prompt: plan.prompt, iterations: dialogues, concurrency: inFlight },
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

    // Runs ONE complete conversation: ask A with the prepared opening, then
    // swap perspectives every turn (each answer restructured so the other
    // person answers it), replaying the whole chat log per request, until the
    // chat-log estimate reaches the 256k target (or the safety cap / a
    // failed-or-cancelled turn ends it).
    const runDialogue = async (cast: RoleplayCast, caseIndex: number) => {
        // The chat log — canonical (speaker, text); the prepared opening data
        // is person B's line, so the first request (A's view) presents it as
        // the user message that ASKS A
        const lines: RoleplayLine[] = [{ speaker: 'B', content: cast.seed }];
        // Context accounting: system setup + every replayed line (+framing) —
        // both perspectives carry the whole chat log and only their (small)
        // setups differ, so the MAX setup drives the stop decision
        let dialogueChars = cast.seed.length + FRAMING_CHARS;
        const maxSetupChars = Math.max(cast.systemA.length, cast.systemB.length);

        for (let turn = 0; turn < ROLEPLAY_MAX_TURNS; turn += 1) {
            const responder: 'A' | 'B' = turn % 2 === 0 ? 'A' : 'B';
            const speaker = responder === 'A' ? cast.personA : cast.personB;
            const runIndex = caseIndex * ROLEPLAY_MAX_TURNS + turn;
            const runStart = performance.now();
            const startTime = (runStart - benchStart) / 1000;
            planned += 1;

            // CANCEL: the entry was cancelled before this turn started —
            // record THIS turn as cancelled and end the conversation without
            // contacting the provider
            if (signal.aborted) {
                runs[runIndex] = failedRun(runIndex, startTime, 0, 0, 'cancelled');
                settled += 1;
                failed += 1;
                publish();
                return;
            }

            // The perspective view: responder as assistant, the other as user
            // (the SAME lines, label-swapped against the previous turn)
            const messages = perspectiveMessages(cast, lines, responder);
            const setupChars = responder === 'A' ? cast.systemA.length : cast.systemB.length;
            const contextTokens = Math.ceil((setupChars + dialogueChars) / 4);

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

                // Replay the answer into the chat log — the NEXT request (the
                // SWAPPED perspective) carries it as the `user` message its
                // speaker answers, and every later request of BOTH views
                // replays it (each label-swapped) — strict continuation
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
                // A failed turn breaks the conversation's continuation chain —
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

            // THE STOP CONDITION: the ENTIRE chat log (the size every next
            // request replays, setups included) reached 256k est. tokens —
            // this conversation (one iteration) is COMPLETE
            const chatLogTokens = Math.ceil((maxSetupChars + dialogueChars) / 4);
            if (chatLogTokens >= ROLEPLAY_TARGET_TOKENS) {
                actions.pushLog(
                    `${cast.name}: chat log reached ${chatLogTokens.toLocaleString('en-US')} est. tok after ` +
                        `${turn + 1} turns — roleplay complete`,
                    'success'
                );
                return;
            }
        }

        // Safety valve tripped (a provider too terse to grow the log toward
        // the target) — the conversation ends at the cap, short of 256k
        actions.pushLog(
            `${cast.name}: stopped at the ${ROLEPLAY_MAX_TURNS.toLocaleString('en-US')}-turn safety cap with the chat log at ` +
                `${Math.ceil((maxSetupChars + dialogueChars) / 4).toLocaleString('en-US')} est. tok — short of the ` +
                `${ROLEPLAY_TARGET_TOKENS.toLocaleString('en-US')} est. tok target`,
            'error'
        );
    };

    // Bounded-concurrency execution of the conversation suite (the same
    // taskCompletion scheduler the core runner uses)
    const scheduler = taskCompletion(inFlight);
    casts.forEach((cast, caseIndex) => {
        scheduler.add(async () => {
            await runDialogue(cast, caseIndex);
        });
    });
    await scheduler.completion();

    // Final report: only the turns actually taken (open-ended conversations
    // leave their unused slots empty), real wall time, aggregated through the
    // real summarizer. Sorted by slot index so the order is deterministic.
    const finalRuns = runs.filter((run): run is BenchRun => Boolean(run)).sort((a, b) => a.index - b.index);
    const wallTime = (performance.now() - benchStart) / 1000;

    const report: BenchmarkReport = {
        model: provider.model,
        config: { prompt: plan.prompt, iterations: dialogues, concurrency: inFlight },
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
// agents are told). Iterations defaults to ONE whole roleplay conversation
// (each grows its chat log to ~256k est. tokens — hundreds of swapped turns)
// and concurrency default 1.
export const roleplayingScenario: BenchScenarioFactory = () =>
    defineBenchScenario({
        id: 'roleplaying',
        name: 'Roleplaying Scenario',
        spec: {
            id: 'roleplaying',
            label: 'Roleplaying',
            icon: '🎭',
            description: `Two named agents roleplay ONE conversation through the SAME model — prepared data asks A, every answer is label-swapped so B answers A's response (and back), until the whole chat log reaches ~${Math.round(ROLEPLAY_TARGET_TOKENS / 1000)}k est. tokens; Iterations = complete conversations (one chat log to the target each), Concurrency = conversations in flight`,
            prompt: ROLEPLAY_INSTRUCTION,
            iterations: 1,
            concurrency: 1
        },
        // CUSTOM execute: the perspective-swapping roleplay (helper.run is
        // single-prompt and cannot express multi-turn conversations)
        execute: executeRoleplaying
    });
