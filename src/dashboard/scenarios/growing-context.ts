// dashboard/scenarios/growing-context.ts — the GROWING CONTEXT scenario.
//
// Converted from the repo-root benchmark-server.ts script (removed after the
// conversion): the agentic CONTEXT TEST. Instead of one fixed prompt it
// emulates N CONCURRENT agent conversations whose context GROWS every turn:
//
//   - each conversation owns one uniquely-seeded synthetic document
//     (GROWING_CONTEXT_FINAL_TOKENS est. tokens, Park-Miller LCG — the same
//     deterministic generator family as packages/test/models
//     benchmark-model.ts buildGrowingContexts);
//   - the document is split into `steps` DISJOINT segments (the panel's
//     Iterations select drives the step count); step k's USER TURN is the
//     k-th segment, the first also carrying the fixed summary instruction;
//   - every turn resends the ENTIRE prior conversation plus the new segment
//     and replays the assistant response into the history — CONTINUATION is
//     REQUIRED for per-lane prefix reuse (ninfer-serve append_frontier): a
//     request only hits the resident prefix when it is a pure suffix append
//     of the previous prompt+response, so a flattened single message would
//     diverge and pay a full re-prefill;
//   - the panel's Concurrency select = conversations in flight (1 = the
//     original script's sequential mode, which isolates per-lane reuse).
//
// Progress is reported PER STEP (each streamed turn is one recorded run) and
// the entry settles with a full BenchmarkReport. Speed semantics: the two
// metrics are reported SEPARATELY (mirroring core BenchRun) — PREFILL =
// promptTokens / ttft (the input rate, the meaningful number for this
// prefill-dominated probe) and DECODE = completionTokens / (totalTime −
// ttft) (the output rate). The scenario only executes against providers
// exposing `generateConversation` (createHttpProvider does);
// single-prompt-only providers are skipped with a console error.
//
// STANDALONE: imports only from the framework + core. Removing this file and
// its line in ./index.ts removes the context test without touching anything
// else.
import { taskCompletion } from '@presource/core';
import { summarizeRuns, type BenchMessage, type BenchRun, type BenchmarkReport } from '../../core';
import type { BenchScenarioFactory, BenchScenarioHelper } from '../framework';
import { defineBenchScenario } from '../framework';
import type { BenchStreamState } from '../context';

// ── Scenario constants (the original script's defaults) ──────────────────────

// Concurrent conversations in the suite (the original buildGrowingContexts
// default: 8 conversations → at the final step all carry ~200k context each)
export const GROWING_CONTEXT_CASES = 8;

// Context size EACH conversation reaches at its final growth step (the
// original default: 200_000 est. tokens → 1.6M est. tokens in flight when
// all conversations run concurrently)
export const GROWING_CONTEXT_FINAL_TOKENS = 200_000;

// Fixed instruction appended after the first context segment — kept
// identical across all conversations and steps so only the context
// size/data varies (verbatim from the original benchmark script)
export const CONTEXT_INSTRUCTION =
    'Read the context document above, then write a detailed summary of at least 200 words. ' +
    'Cover the main themes, key details, and any notable patterns or relationships mentioned. ' +
    'Your summary should be comprehensive and well-structured with multiple paragraphs.';

// ── Deterministic synthetic context generation ───────────────────────────────
// (mirrors packages/test/models/src/benchmark-model.ts: Park-Miller LCG over
// a word pool → seeded, reproducible documents; each conversation index
// generates a DIFFERENT document)

// Word pool large enough that a seeded random walk produces visibly
// different text for every conversation
const CONTEXT_WORDS = [
    'signal', 'harbor', 'copper', 'meadow', 'relay', 'lantern', 'canyon', 'vessel',
    'quartz', 'beacon', 'timber', 'orchard', 'summit', 'fathom', 'marble', 'silt',
    'circuit', 'grove', 'pier', 'granite', 'willow', 'anchor', 'glacier', 'cedar',
    'tessera', 'basalt', 'reede', 'lattice', 'dune', 'prism', 'moss', 'ember',
    'cartography', 'tidal', 'spindle', 'aurora', 'verge', 'quarry', 'halon', 'strata',
    'cavern', 'lumen', 'scaffold', 'drift', 'furnace', 'meander', 'onset', 'palette',
    'rivet', 'solstice', 'transept', 'upland', 'vantage', 'warp', 'zenith', 'archipelago',
    'boulder', 'caravan', 'diffusion', 'estuary', 'fulcrum', 'geode', 'hollow', 'incline',
    'junction', 'keystone', 'ledge', 'meridian', 'nexus', 'oasis', 'pylon', 'quiver'
];

// Park-Miller LCG (mod 2^31-1) — deterministic per seed so the same
// conversation index always generates the identical document
const lcgRandom = (seed: number) => {
    let state = seed % 2147483647;
    if (state <= 0) state += 2147483645;
    return () => {
        state = (state * 16807) % 2147483647;
        return (state - 1) / 2147483646;
    };
};

// One 8-16 word sentence from the seeded walk
const makeContextSentence = (rnd: () => number) => {
    const length = 8 + Math.floor(rnd() * 9);
    const words = Array.from({ length }, () => CONTEXT_WORDS[Math.floor(rnd() * CONTEXT_WORDS.length)]);
    const sentence = words.join(' ');
    return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
};

// Generates ~targetChars of synthetic document text for conversation `index`
// (0-based). Appends whole sentences until the target is reached, then
// slices — chars/4 of the result approximates the requested token budget.
const makeContextDocument = (index: number, targetChars: number) => {
    // Seed is index-based (+1 so conversation 0 doesn't seed state 0, which
    // the LCG would clamp into a low range) — different index, different text
    const rnd = lcgRandom(index + 1);
    let text = `Context document #${index + 1} `;
    while (text.length < targetChars) {
        text += ` ${makeContextSentence(rnd)}`;
    }
    return text.slice(0, targetChars);
};

// One conversation plan: its named step turns (the growing user messages)
export type GrowingConversation = {
    // Display name ("case-1 → 200k ctx")
    name: string;
    // The user turns, in growth order. The FIRST turn carries the document
    // segment + the fixed instruction; later turns are pure context growth.
    steps: string[];
};

/**
 * Builds the growing-conversation suite: `cases` conversations, each with
 * `steps` user turns whose accumulated context grows toward `finalTokens`
 * est. tokens. Segments are cut at rounded boundaries of the shared
 * document, so arbitrary (panel-selected) step counts work — the token
 * budgets are estimates (~chars/4), not exact multiples.
 */
export const buildGrowingConversations = (
    steps: number,
    finalTokens: number = GROWING_CONTEXT_FINAL_TOKENS,
    cases: number = GROWING_CONTEXT_CASES
): GrowingConversation[] => {
    const totalChars = finalTokens * 4;
    return Array.from({ length: cases }, (_, index) => {
        // One full document per conversation, seeded by conversation index —
        // the concurrent conversations each grow a DIFFERENT document
        const document = makeContextDocument(index, totalChars);
        return {
            name: `case-${index + 1} → ${Math.round(finalTokens / 1000)}k ctx`,
            // Disjoint segments at rounded boundaries; the first carries the
            // fixed instruction so later turns are pure context growth
            steps: Array.from({ length: steps }, (_, s) => {
                const start = Math.round((totalChars * s) / steps);
                const end = Math.round((totalChars * (s + 1)) / steps);
                const segment = document.slice(start, end);
                return s === 0 ? `${segment}\n${CONTEXT_INSTRUCTION}` : segment;
            })
        };
    });
};

// ── The executor ─────────────────────────────────────────────────────────────
// Chat-template role framing per message (~"<|im_start|>role\n"), used only
// for the context-size estimate (mirrors benchmark-model.ts FRAMING_CHARS).
const FRAMING_CHARS = 8;

// A failed turn aborts its conversation: the remaining steps are recorded as
// failed runs (error: skipped) so the entry's counter still settles at
// completed == total — the progress bar always reaches 100%.
const skippedError = (step: number) => `skipped: conversation aborted after step ${step} failed`;

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

// The custom execute: the actual context test. Runs the growing-conversation
// suite against the provider's conversation transport, updating the entry
// progressively (one recorded run per streamed turn) and settling it with
// the final report.
const executeGrowingContext = async (helper: BenchScenarioHelper) => {
    const { provider, actions, entryId, plan, signal } = helper;

    // The scenario NEEDS the conversation transport (continuation is the
    // whole point — a flattened single message would defeat prefix reuse)
    const streamConversation = provider.generateConversation;
    if (!streamConversation) {
        actions.pushLog(`growing-context: ${provider.model} has no conversation transport — skipped`, 'error');
        actions.updateEntry(entryId, { status: 'done' });
        return;
    }

    // Plan mapping: Iterations select = growth steps per conversation,
    // Concurrency = conversations in flight. NOTE: through the panel
    // dispatch the Concurrency select is consumed UPSTREAM as parallel bench
    // lanes (model-kit handleRun fans out one entry per lane with
    // concurrency 1) — each lane runs the full suite with its conversations
    // sequential. Direct helper callers (tests) can still pin concurrency
    // here to run this single suite's conversations in parallel.
    const steps = plan.iterations;
    const inFlight = plan.concurrency;
    const conversations = buildGrowingConversations(steps);
    const totalRuns = conversations.length * steps;

    // Initial counter (launchScenario already created the entry 'running')
    actions.updateEntry(entryId, { progress: { completed: 0, failed: 0, total: totalRuns }, streaming: [] });

    // Live per-turn streaming readouts (the entry card's "N tok received"
    // rows) — same throttle/cleanup contract as the compiled helper
    const turnStreams = createTurnStreamPublisher(entryId, actions);

    // Slot-written runs (index = caseIndex * steps + stepIndex) so the report
    // keeps a deterministic suite order no matter the completion order
    const runs: Array<BenchRun | undefined> = new Array(totalRuns);
    let settled = 0;
    let failed = 0;
    const benchStart = performance.now();

    // Publishes the settled-so-far slice as a partial report (progressive
    // panel updates — same contract as the compiled helper's onRun path)
    const publish = () => {
        const settledRuns = runs.filter((run): run is BenchRun => Boolean(run)).sort((a, b) => a.index - b.index);
        const partial: BenchmarkReport = {
            model: provider.model,
            config: { prompt: plan.prompt, iterations: totalRuns, concurrency: inFlight },
            createdAt: new Date().toISOString(),
            wallTime: 0,
            runs: settledRuns,
            summary: summarizeRuns(provider.model, settledRuns, 0)
        };
        actions.updateEntry(entryId, {
            progress: { completed: settled, failed, total: totalRuns },
            streaming: turnStreams.states(),
            report: partial
        });
    };

    // Runs ONE conversation to completion (or aborts it on a failed turn):
    // each step appends its user turn, streams the FULL accumulated history,
    // then replays the assistant response — strict continuation.
    const runConversation = async (conversation: GrowingConversation, caseIndex: number) => {
        const history: BenchMessage[] = [];
        let conversationChars = 0;

        for (let s = 0; s < conversation.steps.length; s += 1) {
            const runIndex = caseIndex * steps + s;
            const runStart = performance.now();
            const startTime = (runStart - benchStart) / 1000;

            // CANCEL: the entry was cancelled before this turn started —
            // record every remaining turn (this one included) as cancelled
            // and stop the conversation without contacting the provider
            if (signal.aborted) {
                for (let rest = s; rest < conversation.steps.length; rest += 1) {
                    runs[caseIndex * steps + rest] = {
                        index: caseIndex * steps + rest,
                        startTime,
                        ttft: 0,
                        totalTime: 0,
                        promptTokens: 0,
                        completionTokens: 0,
                        totalTokens: 0,
                        contentLength: 0,
                        prefillTokensPerSec: 0,
                        tokensPerSec: 0,
                        error: 'cancelled'
                    };
                    failed += 1;
                    settled += 1;
                }
                publish();
                return;
            }
            history.push({ role: 'user', content: conversation.steps[s] });
            conversationChars += conversation.steps[s].length + FRAMING_CHARS;
            const contextTokens = Math.ceil(conversationChars / 4);

            // First-chunk TTFT latch (mirrors the core runner)
            let ttft = 0;
            let firstChunk = true;
            // Characters received so far THIS turn — accumulated across
            // chunks and reported live through the turn-stream publisher
            // (est. tokens = ceil(chars / 4), the same heuristic the final
            // token accounting uses when usage is missing)
            let received = 0;

            try {
                // Snapshot the history for this request — the provider gets
                // an immutable view of the exact conversation it received
                // (the live array keeps growing for the next turn). The
                // entry's cancellation signal rides along so an abort
                // rejects the in-flight request immediately.
                const result = await streamConversation([...history], (chunk) => {
                    // ONE clock read per chunk — mirrors the core runner
                    const stamp = performance.now();
                    if (firstChunk) {
                        ttft = (stamp - runStart) / 1000;
                        firstChunk = false;
                    }

                    // LIVE STREAMING FEEDBACK: accumulate the received text
                    // into this turn's readout so the entry card shows
                    // "N tok received · X tok/s" while the turn generates
                    // (`first` = this chunk is the turn's first — the
                    // publisher flushes it immediately)
                    received += chunk.length;
                    const elapsed = (stamp - runStart) / 1000;
                    // LIVE rate = DECODE speed (the OUTPUT metric, same
                    // definition as the settled run): output tokens received
                    // so far over the post-TTFT phase, guarded against a
                    // zero-length phase — the first chunk lands exactly AT
                    // ttft, so its rate reads 0 by definition. (The input
                    // side — prefill — has no live signal: no chunks fire
                    // during the prefill, it is visible through ttft.)
                    const streamedTokens = Math.ceil(received / 4);
                    const generationPhase = elapsed - ttft;
                    turnStreams.record(
                        {
                            index: runIndex,
                            chars: received,
                            tokens: streamedTokens,
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
                // same definitions as the core runner):
                // - PREFILL (input): promptTokens / ttft — context tokens
                //   processed per second before the first output token. THE
                //   meaningful rate for this prefill-dominated probe (a
                //   ~200-word summary decodes in a sub-second sliver of a
                //   10–30s turn, so the decode rate alone swings wildly
                //   between steps without the prefill number next to it).
                // - DECODE (output): completionTokens / (totalTime − ttft) —
                //   sustained generation speed over the OUTPUT phase only,
                //   guarded against a zero-length phase.
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
                    tokensPerSec
                };

                // Replay the response into the next turn's history — THIS is
                // what makes turn s+1 a pure suffix append of turn s
                history.push({ role: 'assistant', content });
                conversationChars += content.length + FRAMING_CHARS;

                actions.pushLog(
                    `step ${s + 1}/${steps} — ${conversation.name}: ${contextTokens.toLocaleString('en-US')} tok ctx, ` +
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
                runs[runIndex] = {
                    index: runIndex,
                    startTime,
                    ttft,
                    totalTime,
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                    contentLength: 0,
                    prefillTokensPerSec: 0,
                    tokensPerSec: 0,
                    error: message
                };
                actions.pushLog(
                    signal.aborted
                        ? `step ${s + 1}/${steps} — ${conversation.name} cancelled`
                        : `step ${s + 1}/${steps} — ${conversation.name} FAILED (${message})`,
                    signal.aborted ? 'info' : 'error'
                );
                // A failed turn breaks the conversation's continuation chain —
                // record the remaining steps as skipped so the counter settles
                // (after a CANCEL they are simply cancelled, not skipped)
                for (let rest = s + 1; rest < conversation.steps.length; rest += 1) {
                    runs[caseIndex * steps + rest] = {
                        index: caseIndex * steps + rest,
                        startTime,
                        ttft: 0,
                        totalTime: 0,
                        promptTokens: 0,
                        completionTokens: 0,
                        totalTokens: 0,
                        contentLength: 0,
                        prefillTokensPerSec: 0,
                        tokensPerSec: 0,
                        error: signal.aborted ? 'cancelled' : skippedError(s + 1)
                    };
                    failed += 1;
                    settled += 1;
                }
                failed += 1;
                settled += 1;
                publish();
                return;
            }

            settled += 1;
            // The settled turn's live readout leaves the strip
            turnStreams.remove(runIndex);
            publish();
        }
    };

    // Bounded-concurrency execution of the conversation suite (the same
    // taskCompletion scheduler the core runner uses)
    const scheduler = taskCompletion(inFlight);
    conversations.forEach((conversation, caseIndex) => {
        scheduler.add(async () => {
            await runConversation(conversation, caseIndex);
        });
    });
    await scheduler.completion();

    // Final report: every slot is guaranteed filled (a conversation that
    // aborts mid-way records its remaining steps as skipped), real wall
    // time, aggregated through the real summarizer. Sorted by slot index so
    // the suite order is deterministic regardless of completion order.
    const finalRuns = runs.filter((run): run is BenchRun => Boolean(run)).sort((a, b) => a.index - b.index);
    const wallTime = (performance.now() - benchStart) / 1000;

    const report: BenchmarkReport = {
        model: provider.model,
        config: { prompt: plan.prompt, iterations: totalRuns, concurrency: inFlight },
        createdAt: new Date().toISOString(),
        wallTime,
        runs: finalRuns,
        summary: summarizeRuns(provider.model, finalRuns, wallTime)
    };
    actions.addReport(report);
    actions.updateEntry(entryId, { status: 'done', report });
};

// ── The scenario plugin ──────────────────────────────────────────────────────
// Spec: the summary instruction doubles as the display prompt (it IS the
// fixed suffix of every first turn). Iterations default 8 / concurrency
// default 1 — the original script's shape; the panel's selects re-pin both.
export const growingContextScenario: BenchScenarioFactory = () =>
    defineBenchScenario({
        id: 'growing-context',
        name: 'Growing Context Scenario',
        spec: {
            id: 'growing-context',
            label: 'Growing Context',
            icon: '📚',
            description: `Agentic context growth — ${GROWING_CONTEXT_CASES} conversations extend to ~200k est. tokens with strict continuation (prefix-reuse probe)`,
            prompt: CONTEXT_INSTRUCTION,
            iterations: 8,
            concurrency: 1
        },
        // CUSTOM execute: the conversation-based context test (helper.run is
        // single-prompt and cannot express continuation)
        execute: executeGrowingContext
    });
