// dashboard/scenarios/scenarios.test.ts — exact-value tests for the scenario
// plugin system.
//
// Covers the entry-based run contract:
//   - SCENARIOS: the standalone scenario factories produce complete plugins
//     through the real framework bundle (dropdown order + specs are exact).
//   - compileScenarioHelper: the compiled helper drives the core engine with
//     progressive feedback — per-run entry progress updates, per-run partial
//     reports, and the authoritative final report — all asserted with EXACT
//     values against a stub provider + injectable fake clock (+1000ms per
//     clock call → every timing is deterministic).
//   - launchScenario: one call creates ONE benchmark entry (exact fields),
//     executes the scenario against it and settles it as 'done' — the
//     building block the panel fires N times in parallel.
//   - createScenario's default execute: `plugin.execute(helper)` runs the
//     helper's plan without any extra wiring.
import { describe, expect, it } from 'vitest';
import { BENCH_FRAMEWORK, compileScenarioHelper, launchScenario } from '../framework';
import type { BenchScenarioActions, BenchScenarioPlugin } from '../framework';
import { SCENARIOS } from './index';
import {
    CALENDAR_PROMPT,
    CALENDAR_TOOL,
    REMINDER_TOOL,
    SEARCH_TOOL,
    SHIPMENT_EXPECTED_CALL,
    SHIPMENT_PROMPT,
    SHIPMENT_TOOL,
    TOOL_RESPONSE_INSTRUCTION,
    WEATHER_EXPECTED_CALL,
    WEATHER_PROMPT,
    WEATHER_TOOL,
    buildToolPrompt,
    calendarCallInstruction,
    shipmentCallInstruction,
    weatherCallInstruction
} from './tool-fixtures';
import { cancelEntryRun, type BenchEntry, type BenchStreamState } from '../context';
import type { BenchGeneration, BenchmarkReport } from '../../core';

// ── Test doubles ─────────────────────────────────────────────────────────────

// Fake ms clock: +1000ms per call. The runner samples the clock a fixed
// number of times per run (benchStart + runStart + chunk + end), so every
// reported timing is a deterministic integer-second value.
const fakeClock = () => {
    let tick = 0;
    return () => (tick += 1) * 1000;
};

// Stub provider: emits one chunk (TTFT) then resolves with fixed usage.
// 4-char content + explicit usage → tokensPerSec = 4 / (2 - 1) = 4.0 exactly.
const stubProvider = (model = 'mock-model') => ({
    model,
    generate: async (prompt: string, onUpdate?: (chunk: string) => void): Promise<BenchGeneration> => {
        onUpdate?.('x');
        return { content: 'abcd', model, usage: { promptTokens: 2, completionTokens: 4, totalTokens: 6 } };
    }
});

// Recorder for the BenchScenarioActions slice the helper talks to — entries
// are mirrored into a plain array so assertions read like the store state.
const recordActions = () => {
    const logs: Array<{ text: string; tone: string }> = [];
    const reports: BenchmarkReport[] = [];
    const entries: BenchEntry[] = [];
    const actions: BenchScenarioActions & { addEntry: (entry: BenchEntry) => void } = {
        pushLog: (text, tone = 'info') => logs.push({ text, tone }),
        addReport: (report) => reports.push(report),
        addEntry: (entry) => {
            // Same newest-first prepend the real store action performs
            entries.unshift(entry);
        },
        updateEntry: (entryId, patch) => {
            const index = entries.findIndex((entry) => entry.id === entryId);
            if (index === -1) {
                // Direct-helper tests (no launchScenario) — synthesize the
                // entry shell so patches accumulate exactly like the store
                entries.unshift({ id: entryId, ...patch } as BenchEntry);
                return;
            }
            entries[index] = { ...entries[index], ...patch };
        }
    };
    return { logs, reports, entries, actions };
};

// Loads every registered scenario through the REAL framework bundle — the
// test asserts what the dashboard actually loads, not just wiring.
const loadScenarios = (): BenchScenarioPlugin[] => SCENARIOS.map((factory) => factory(BENCH_FRAMEWORK));

// ── The scenario registry ────────────────────────────────────────────────────

describe('SCENARIOS (the standalone scenario plugin list)', () => {
    it('registers the default scenario set in dropdown order with exact specs', () => {
        const scenarios = loadScenarios();

        expect(
            scenarios.map((scenario) => ({
                id: scenario.id,
                name: scenario.name,
                label: scenario.spec.label,
                icon: scenario.spec.icon,
                iterations: scenario.spec.iterations,
                concurrency: scenario.spec.concurrency
            }))
        ).toEqual([
            { id: 'short-story', name: 'Short Story Scenario', label: 'Short Story', icon: '📝', iterations: 3, concurrency: 1 },
            { id: 'summarization', name: 'Summarization Scenario', label: 'Summarization', icon: '📄', iterations: 2, concurrency: 1 },
            { id: 'brainstorm', name: 'Brainstorm Scenario', label: 'Brainstorm', icon: '💡', iterations: 2, concurrency: 2 },
            { id: 'growing-context', name: 'Growing Context Scenario', label: 'Growing Context', icon: '📚', iterations: 8, concurrency: 1 },
            { id: 'tool-call', name: 'Tool Call Scenario', label: 'Tool Call', icon: '🛠️', iterations: 2, concurrency: 1 },
            { id: 'tool-parallel', name: 'Tool Selection Scenario', label: 'Tool Selection', icon: '🎯', iterations: 2, concurrency: 1 },
            { id: 'tool-args', name: 'Tool Args Scenario', label: 'Tool Args', icon: '📦', iterations: 2, concurrency: 1 }
        ]);
    });

    it('carries the exact prompt per scenario (the test definition itself)', () => {
        const [shortStory, summarization, brainstorm] = loadScenarios();

        expect(shortStory.spec.prompt).toBe('Write me a short story about a lighthouse keeper. Maximum of 1000 words.');
        expect(summarization.spec.prompt.startsWith('Summarize the following passage in one sentence:')).toBe(true);
        expect(brainstorm.spec.prompt).toBe('Brainstorm 10 creative names for a small coffee shop by the sea.');
    });
});

// ── The tool-calling fixtures ────────────────────────────────────────────────

describe('tool-call fixtures (deterministic prompt builder + canonical calls)', () => {
    it('builds the exact four-line prompt shape from offered tools + instruction', () => {
        // The builder is deterministic: header, schema JSON, steering line,
        // shared contract suffix — one newline-joined block
        expect(buildToolPrompt([WEATHER_TOOL], weatherCallInstruction)).toBe(
            [
                '# Tools',
                JSON.stringify([WEATHER_TOOL]),
                weatherCallInstruction,
                "Call the correct tool and fill ALL required arguments with concrete values from the user's message. " +
                    TOOL_RESPONSE_INSTRUCTION
            ].join('\n')
        );
        // The prebuilt prompts pass through the same builder (no drift)
        expect(WEATHER_PROMPT).toBe(buildToolPrompt([WEATHER_TOOL], weatherCallInstruction));
        expect(CALENDAR_PROMPT).toBe(buildToolPrompt([CALENDAR_TOOL, REMINDER_TOOL, SEARCH_TOOL], calendarCallInstruction));
        expect(SHIPMENT_PROMPT).toBe(buildToolPrompt([SHIPMENT_TOOL], shipmentCallInstruction));
    });

    it('keeps the schema payloads exact: offered tool sets + required slots', () => {
        // Single-tool baseline: one tool, two required args
        expect(WEATHER_PROMPT).toContain(JSON.stringify([WEATHER_TOOL]));
        expect(WEATHER_PROMPT).toContain('"get_weather"');
        expect(WEATHER_PROMPT).toContain('["city","unit"]');

        // Selection probe: THREE tools offered, target listed first
        expect(CALENDAR_PROMPT).toContain(JSON.stringify([CALENDAR_TOOL, REMINDER_TOOL, SEARCH_TOOL]));
        expect(CALENDAR_PROMPT).toContain('"create_event"');
        expect(CALENDAR_PROMPT).toContain('"set_reminder"');
        expect(CALENDAR_PROMPT).toContain('"web_search"');
        expect(CALENDAR_PROMPT).toContain('["title","date","time"]');

        // Arg-filling probe: one tool with FIVE required slots (two enums)
        expect(SHIPMENT_PROMPT).toContain(JSON.stringify([SHIPMENT_TOOL]));
        expect(SHIPMENT_PROMPT).toContain('["carrier","service","weightKg","pickupDate","address"]');
        expect(SHIPMENT_PROMPT).toContain('["dhl","fedex","ups"]');
        expect(SHIPMENT_PROMPT).toContain('["standard","express","overnight"]');

        // The JSON-only response demand rides along in every variant
        expect(WEATHER_PROMPT).toContain(TOOL_RESPONSE_INSTRUCTION);
        expect(CALENDAR_PROMPT).toContain(TOOL_RESPONSE_INSTRUCTION);
        expect(SHIPMENT_PROMPT).toContain(TOOL_RESPONSE_INSTRUCTION);
    });

    it('pins the canonical expected calls per variant', () => {
        expect(WEATHER_EXPECTED_CALL).toBe('{"name": "get_weather", "arguments": {"city": "Tokyo", "unit": "celsius"}}');
        expect(SHIPMENT_EXPECTED_CALL).toBe(
            '{"name": "schedule_shipment", "arguments": {"carrier": "fedex", "service": "overnight", "weightKg": 3.5, "pickupDate": "2026-10-02", "address": "12 Orchard Lane, Springfield"}}'
        );
        // Canonical calls must parse as JSON objects (the contract the model
        // is asked to satisfy — a fixture that isn't valid JSON would be a
        // broken benchmark)
        expect(JSON.parse(WEATHER_EXPECTED_CALL)).toEqual({
            name: 'get_weather',
            arguments: { city: 'Tokyo', unit: 'celsius' }
        });
        expect(JSON.parse(SHIPMENT_EXPECTED_CALL)).toEqual({
            name: 'schedule_shipment',
            arguments: { carrier: 'fedex', service: 'overnight', weightKg: 3.5, pickupDate: '2026-10-02', address: '12 Orchard Lane, Springfield' }
        });
    });
});

// ── The tool-calling scenarios ───────────────────────────────────────────────

describe('tool-calling scenarios', () => {
    it('embeds the exact fixture prompts per variant', () => {
        const scenarios = loadScenarios();
        const toolCall = scenarios.find((scenario) => scenario.id === 'tool-call')!;
        const toolParallel = scenarios.find((scenario) => scenario.id === 'tool-parallel')!;
        const toolArgs = scenarios.find((scenario) => scenario.id === 'tool-args')!;

        // Baseline: single weather tool; Selection: three offered tools;
        // Args: the five-slot shipment tool
        expect(toolCall.spec.prompt).toBe(WEATHER_PROMPT);
        expect(toolParallel.spec.prompt).toBe(CALENDAR_PROMPT);
        expect(toolArgs.spec.prompt).toBe(SHIPMENT_PROMPT);

        // The steering sentences name the target per variant
        expect(toolCall.spec.prompt).toContain(weatherCallInstruction);
        expect(toolParallel.spec.prompt).toContain(calendarCallInstruction);
        expect(toolArgs.spec.prompt).toContain(shipmentCallInstruction);
    });

    it('runs the tool-call baseline end-to-end: one entry with the fixture prompt, settled done', async () => {
        const recorder = recordActions();
        const toolCall = loadScenarios().find((scenario) => scenario.id === 'tool-call')!;

        await launchScenario({
            scenario: toolCall,
            modelId: 'tool-model',
            modelLabel: 'tool-model',
            provider: stubProvider('tool-model'),
            actions: recorder.actions,
            timing: { clock: fakeClock(), now: () => '2026-01-01T00:00:00.000Z' }
        });

        // The entry carries the scenario's fixture prompt and its default
        // plan (2 iterations, sequential)
        const entry = recorder.entries[0];
        expect(entry.scenarioId).toBe('tool-call');
        expect(entry.scenarioLabel).toBe('Tool Call');
        expect(entry.prompt).toBe(WEATHER_PROMPT);
        expect(entry.iterations).toBe(2);
        expect(entry.concurrency).toBe(1);
        expect(entry.status).toBe('done');
        expect(entry.progress).toEqual({ completed: 2, failed: 0, total: 2 });
        expect(entry.report?.config).toEqual({ prompt: WEATHER_PROMPT, iterations: 2, concurrency: 1 });
        // Both runs measured against the stub — prefill 2/1 = 2, decode 4/1 = 4
        expect(entry.report?.runs).toEqual([
            { index: 0, startTime: 1, ttft: 1, totalTime: 2, promptTokens: 2, completionTokens: 4, totalTokens: 6, contentLength: 4, prefillTokensPerSec: 2, tokensPerSec: 4, content: 'abcd' },
            { index: 1, startTime: 4, ttft: 1, totalTime: 2, promptTokens: 2, completionTokens: 4, totalTokens: 6, contentLength: 4, prefillTokensPerSec: 2, tokensPerSec: 4, content: 'abcd' }
        ]);
    });

    it('runs the tool-args variant end-to-end through the compiled helper', async () => {
        const recorder = recordActions();
        const toolArgs = loadScenarios().find((scenario) => scenario.id === 'tool-args')!;

        const helper = compileScenarioHelper({
            spec: toolArgs.spec,
            provider: stubProvider('args-model'),
            entryId: 'bench-1',
            actions: recorder.actions,
            timing: { clock: fakeClock(), now: () => '2026-01-01T00:00:00.000Z' }
        });

        const report = await toolArgs.execute(helper);

        // The scenario's own plan drove the run (2 sequential iterations of
        // the shipment fixture prompt)
        expect(report.config).toEqual({ prompt: SHIPMENT_PROMPT, iterations: 2, concurrency: 1 });
        expect(report.summary).toEqual(
            expect.objectContaining({ model: 'args-model', runCount: 2, completedRuns: 2, failedRuns: 0, successRate: 1 })
        );
        expect(recorder.entries[0].status).toBe('done');
    });
});

// ── The compiled helper ──────────────────────────────────────────────────────

describe('compileScenarioHelper', () => {
    it('runs the engine with progressive feedback: exact entry updates, logs and reports', async () => {
        const recorder = recordActions();
        const helper = compileScenarioHelper({
            spec: { id: 'test', label: 'Test Scenario', prompt: 'Tell me a story', iterations: 3, concurrency: 1 },
            provider: stubProvider(),
            entryId: 'bench-1',
            actions: recorder.actions,
            timing: { clock: fakeClock(), now: () => '2026-01-01T00:00:00.000Z' }
        });

        const report = await helper.run();

        // ── Final report: exact per-run measurements (clock +1000ms/call →
        // startTime 1/4/7, ttft 1, totalTime 2, prefill 2/1 = 2,
        // tokensPerSec = 4 / (2 - 1) = 4.0 exactly)
        expect(report.model).toBe('mock-model');
        expect(report.config).toEqual({ prompt: 'Tell me a story', iterations: 3, concurrency: 1 });
        expect(report.createdAt).toBe('2026-01-01T00:00:00.000Z');
        expect(report.wallTime).toBe(10);
        expect(report.runs).toEqual([
            { index: 0, startTime: 1, ttft: 1, totalTime: 2, promptTokens: 2, completionTokens: 4, totalTokens: 6, contentLength: 4, prefillTokensPerSec: 2, tokensPerSec: 4, content: 'abcd' },
            { index: 1, startTime: 4, ttft: 1, totalTime: 2, promptTokens: 2, completionTokens: 4, totalTokens: 6, contentLength: 4, prefillTokensPerSec: 2, tokensPerSec: 4, content: 'abcd' },
            { index: 2, startTime: 7, ttft: 1, totalTime: 2, promptTokens: 2, completionTokens: 4, totalTokens: 6, contentLength: 4, prefillTokensPerSec: 2, tokensPerSec: 4, content: 'abcd' }
        ]);
        expect(report.summary).toEqual({
            model: 'mock-model',
            runCount: 3,
            completedRuns: 3,
            failedRuns: 0,
            successRate: 1,
            minTtft: 1,
            maxTtft: 1,
            avgTtft: 1,
            medianTtft: 1,
            minTime: 2,
            maxTime: 2,
            avgTime: 2,
            throughput: 4,
            avgPrefillTokensPerSec: 2,
            maxTokensPerSec: 4,
            avgCompletionTokens: 4,
            avgPromptTokens: 2,
            wallTime: 10
        });

        // ── PROGRESSIVE FEEDBACK: the entry's counter advances per settled
        // run and the entry settles 'done' with the final report (the entry
        // shell is synthesized by the recorder — direct helper, no launch).
        // The streaming strip is fully cleared: every run settled, so no
        // in-flight readouts remain.
        expect(recorder.entries).toEqual([
            {
                id: 'bench-1',
                progress: { completed: 3, failed: 0, total: 3 },
                report,
                status: 'done',
                streaming: []
            }
        ]);

        // ── Console feed: engine log lines with resolved tones. Per-run
        // lines carry BOTH speed metrics (prefill = prompt/ttft = 2/1 = 2.0;
        // decode = completion/(total−ttft) = 4/1 = 4.0)
        expect(recorder.logs).toEqual([
            { text: 'start 3× "Tell me a story" @ mock-model (concurrency 1)', tone: 'info' },
            { text: 'run 1/3 done in 2.00s (2.0 tok/s prefill, 4.0 tok/s decode)', tone: 'info' },
            { text: 'run 2/3 done in 2.00s (2.0 tok/s prefill, 4.0 tok/s decode)', tone: 'info' },
            { text: 'run 3/3 done in 2.00s (2.0 tok/s prefill, 4.0 tok/s decode)', tone: 'info' },
            { text: 'finish mock-model: 3/3 ok, 2.0 tok/s prefill avg, 4.0 tok/s decode avg', tone: 'success' }
        ]);

        // ── Partial reports: one per settled run (progressive entry updates)
        // + the authoritative final report. Partials summarize ONLY the runs
        // finished so far (runCount 1 → 3, wallTime 0 mid-flight).
        expect(recorder.reports.length).toBe(4);
        expect(recorder.reports.map((partial) => partial.summary.runCount)).toEqual([1, 2, 3, 3]);
        expect(recorder.reports[0].summary).toEqual(
            expect.objectContaining({ runCount: 1, completedRuns: 1, wallTime: 0, throughput: 4 })
        );
        // The last report IS the final one (full wallTime + summary)
        expect(recorder.reports[3]).toEqual(report);
    });

    it('counts failed runs in the entry progress and keeps them out of the stats', async () => {
        const recorder = recordActions();
        let call = 0;
        // Flaky provider: iteration 1 aborts, iteration 2 streams fine
        const flakyProvider = {
            model: 'flaky-model',
            generate: async (prompt: string, onUpdate?: (chunk: string) => void): Promise<BenchGeneration> => {
                call += 1;
                if (call === 1) throw new Error('boom');
                onUpdate?.('x');
                return { content: 'abcd', model: 'flaky-model', usage: { promptTokens: 2, completionTokens: 4, totalTokens: 6 } };
            }
        };

        const helper = compileScenarioHelper({
            spec: { id: 'test', label: 'Flaky Scenario', prompt: 'ping', iterations: 2, concurrency: 1 },
            provider: flakyProvider,
            entryId: 'bench-1',
            actions: recorder.actions,
            timing: { clock: fakeClock(), now: () => '2026-01-01T00:00:00.000Z' }
        });

        const report = await helper.run();

        // Failed run: error captured, token fields zeroed (runner contract)
        expect(report.runs[0]).toEqual({
            index: 0,
            startTime: 1,
            ttft: 0,
            totalTime: 1,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            contentLength: 0,
            prefillTokensPerSec: 0,
            tokensPerSec: 0,
            error: 'boom'
        });

        // The entry tracks the failure as it happens (1 settled, 1 failed)
        expect(recorder.entries[0].progress).toEqual({ completed: 2, failed: 1, total: 2 });
        expect(recorder.entries[0].status).toBe('done');

        // Stats exclude the failed run; the console marks it red
        expect(report.summary).toEqual(
            expect.objectContaining({ runCount: 2, completedRuns: 1, failedRuns: 1, successRate: 0.5, wallTime: 6 })
        );
        expect(recorder.logs[1]).toEqual({ text: 'run 1/2 FAILED (boom)', tone: 'error' });
    });

    it('streams live per-run readouts into the entry and clears each on settle', async () => {
        const recorder = recordActions();
        // Capture every `streaming` patch the helper writes (the reset, one
        // per in-flight update, and the per-settle clears)
        const streamPatches: Array<BenchStreamState[] | undefined> = [];
        const baseUpdate = recorder.actions.updateEntry;
        recorder.actions.updateEntry = (entryId, patch) => {
            if ('streaming' in patch) streamPatches.push(patch.streaming);
            baseUpdate(entryId, patch);
        };

        // Two-chunk provider, 1 iteration. Fake clock +1000ms/call:
        //   1000 bench; 2000 run start; 3000 chunk1 (elapsed 1 = ttft, 4 chars
        //   → 1 est. token, phase 0 → rate 0); 4000 chunk2 (elapsed 2, 12 chars
        //   → 3 est. tokens, phase 1 → rate 3); 5000 run end
        const streamingProvider = {
            model: 'stream-model',
            generate: async (prompt: string, onUpdate?: (chunk: string) => void): Promise<BenchGeneration> => {
                onUpdate?.('abcd');
                onUpdate?.('efghijkl');
                return { content: 'abcdefghijkl', model: 'stream-model' };
            }
        };

        const helper = compileScenarioHelper({
            spec: { id: 'test', label: 'Stream Scenario', prompt: 'go', iterations: 1, concurrency: 1 },
            provider: streamingProvider,
            entryId: 'bench-1',
            actions: recorder.actions,
            // The throttle clock is INDEPENDENT of the timing clock (extra
            // samples on the timing clock would shift the pinned run
            // timings) — this fake advances +1000ms per push, so every
            // non-forced push clears the 150ms throttle
            timing: { clock: fakeClock(), streamClock: fakeClock(), now: () => '2026-01-01T00:00:00.000Z' }
        });

        await helper.run();

        // EXACT streaming patch sequence (text = the streamed words so far):
        //   1. the run's reset (empty strip)
        //   2. chunk1's forced first-tick push (the row appears without delay)
        //   3. chunk2's push (fake clock advances 1000ms ≥ the 150ms throttle)
        //   4. the settle clear (onRun retires the run's readout)
        expect(streamPatches).toEqual([
            [],
            [{ index: 0, chars: 4, tokens: 1, text: 'abcd', elapsed: 1, tokensPerSec: 0 }],
            [{ index: 0, chars: 12, tokens: 3, text: 'abcdefghijkl', elapsed: 2, tokensPerSec: 3 }],
            []
        ]);
        // The entry settles with the streaming strip fully cleared
        expect(recorder.entries[0].streaming).toEqual([]);
    });

    it('layers per-call overrides over the pinned plan without mutating the spec', async () => {
        const recorder = recordActions();
        const spec = { id: 'test', label: 'Override Scenario', prompt: 'default prompt', iterations: 3, concurrency: 1 };
        const helper = compileScenarioHelper({
            spec,
            provider: stubProvider(),
            entryId: 'bench-1',
            actions: recorder.actions,
            // The panel's selects pin this plan at launch time
            plan: { iterations: 5, concurrency: 2 },
            timing: { clock: fakeClock() }
        });

        // No per-call override → the PINNED plan wins over the spec default
        const pinned = await helper.run();
        expect(pinned.config).toEqual({ prompt: 'default prompt', iterations: 5, concurrency: 2 });
        expect(recorder.entries[0].progress?.total).toBe(5);

        // Per-call override wins over BOTH the pinned plan and the spec…
        const overridden = await helper.run({ iterations: 1 });
        expect(overridden.config).toEqual({ prompt: 'default prompt', iterations: 1, concurrency: 2 });
        // …and the spec is untouched (the next run gets the same defaults)
        expect(spec.iterations).toBe(3);
    });
});

// ── The launcher ─────────────────────────────────────────────────────────────

describe('launchScenario', () => {
    it('creates ONE benchmark entry with exact fields, runs it, settles it done', async () => {
        const recorder = recordActions();
        const [shortStory] = loadScenarios();

        await launchScenario({
            scenario: shortStory,
            modelId: 'modal/kimi-k3',
            modelLabel: 'kimi-k3 (modal)',
            provider: stubProvider('modal/kimi-k3'),
            actions: recorder.actions,
            // The panel's selects pin the plan at launch
            plan: { iterations: 2, concurrency: 1 },
            timing: { clock: fakeClock(), now: () => '2026-01-01T00:00:00.000Z' }
        });

        // Exactly ONE entry, created with the launch plan baked in
        expect(recorder.entries.length).toBe(1);
        expect(recorder.entries[0]).toEqual({
            id: expect.stringMatching(/^bench-\d+$/),
            model: 'modal/kimi-k3',
            modelLabel: 'kimi-k3 (modal)',
            scenarioId: 'short-story',
            scenarioLabel: 'Short Story',
            prompt: 'Write me a short story about a lighthouse keeper. Maximum of 1000 words.',
            iterations: 2,
            concurrency: 1,
            status: 'done',
            progress: { completed: 2, failed: 0, total: 2 },
            // All runs settled → the live streaming strip is empty
            streaming: [],
            report: expect.objectContaining({ model: 'modal/kimi-k3' })
        });
        // The final report carries the pinned plan + full summary
        expect(recorder.entries[0].report?.config).toEqual({
            prompt: 'Write me a short story about a lighthouse keeper. Maximum of 1000 words.',
            iterations: 2,
            concurrency: 1
        });
        expect(recorder.entries[0].report?.summary.runCount).toBe(2);
    });

    it('settles the entry and logs an error when the scenario execute throws', async () => {
        const recorder = recordActions();
        const bombScenario: BenchScenarioPlugin = {
            id: 'bomb',
            name: 'Bomb Scenario',
            spec: { id: 'bomb', label: 'Bomb', prompt: 'x', iterations: 1 },
            // A misbehaving custom execute — the entry must still settle
            execute: () => {
                throw new Error('custom scenario exploded');
            }
        };

        await launchScenario({
            scenario: bombScenario,
            modelId: 'm',
            modelLabel: 'm',
            provider: stubProvider('m'),
            actions: recorder.actions
        });

        expect(recorder.entries[0].status).toBe('done');
        expect(recorder.entries[0].report).toBeNull();
        expect(recorder.logs).toEqual([{ text: 'bench aborted: custom scenario exploded', tone: 'error' }]);
    });

    it('cancelEntryRun aborts the entry: in-flight run cancelled, queue skipped, entry settles', async () => {
        const recorder = recordActions();
        let providerCalls = 0;
        // Provider whose generate hangs until its signal aborts — only the
        // FIRST iteration ever reaches it (the queue skips the rest)
        const hangingProvider = {
            model: 'cancel-model',
            generate: (prompt: string, onUpdate?: (chunk: string) => void, signal?: AbortSignal): Promise<BenchGeneration> =>
                new Promise((_resolve, reject) => {
                    providerCalls += 1;
                    signal?.addEventListener('abort', () => reject(new Error('aborted')));
                })
        };
        const [shortStory] = loadScenarios();

        // launchScenario creates the entry + dispatches run 0 synchronously
        const pending = launchScenario({
            scenario: shortStory,
            modelId: 'cancel-model',
            modelLabel: 'cancel-model',
            provider: hangingProvider,
            actions: recorder.actions,
            plan: { iterations: 2, concurrency: 1 },
            timing: { clock: fakeClock(), now: () => '2026-01-01T00:00:00.000Z' }
        });
        expect(recorder.entries.length).toBe(1);
        const entryId = recorder.entries[0].id;
        expect(recorder.entries[0].status).toBe('running');

        // Cancel through the REAL store registry — the exact path the entry
        // card's hover CANCEL button drives (store cancelEntry action)
        cancelEntryRun(entryId);
        await pending;

        // The entry settles 'done' with BOTH runs recorded as cancelled
        const entry = recorder.entries[0];
        expect(entry.status).toBe('done');
        expect(entry.report?.runs.map((run) => run.error)).toEqual(['cancelled', 'cancelled']);
        // Only run 0 ever contacted the provider; run 1 was queue-skipped
        expect(providerCalls).toBe(1);
        // The console feed records the cancellation as info lines (NOT
        // errors) — one per cancelled run, then the finish roll-up
        expect(recorder.logs.map((line) => ({ text: line.text, tone: line.tone }))).toEqual([
            { text: 'start 2× "Write me a short story about a lighthouse keeper. Maximum of 1000 words." @ cancel-model (concurrency 1)', tone: 'info' },
            { text: 'run 1/2 cancelled', tone: 'info' },
            { text: 'run 2/2 cancelled', tone: 'info' },
            { text: 'finish cancel-model: 0/2 ok, 0.0 tok/s prefill avg, 0.0 tok/s decode avg', tone: 'success' }
        ]);
    });
});

// ── The scenario recipe ──────────────────────────────────────────────────────

describe('createScenario default execute', () => {
    it('runs the compiled helper with no extra wiring (plugin.execute → report)', async () => {
        const recorder = recordActions();
        // Load the REAL default scenario plugin through the framework bundle
        const [shortStory] = loadScenarios();

        const helper = compileScenarioHelper({
            spec: shortStory.spec,
            provider: stubProvider('story-model'),
            entryId: 'bench-1',
            actions: recorder.actions,
            timing: { clock: fakeClock() }
        });

        // launchScenario calls exactly this — no framework glue required
        await shortStory.execute(helper);

        // The scenario's own plan drove the run: 3 iterations committed
        expect(recorder.reports.length).toBe(4);
        expect(recorder.reports[3].model).toBe('story-model');
        expect(recorder.reports[3].config.prompt).toBe('Write me a short story about a lighthouse keeper. Maximum of 1000 words.');
        expect(recorder.reports[3].summary.runCount).toBe(3);
    });
});
