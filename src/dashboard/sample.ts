// dashboard/sample.ts — deterministic fixture reports for stories and tests.
//
// The samples are BUILT THROUGH THE REAL ENGINE (summarizeRuns) so the numbers
// on screen are genuinely consistent: every summary field the dashboard shows
// is derived from the same raw runs a live benchmark would produce.
//
// The three models are written to a plausible relative shape:
//   qwen3.8-27b     — the champion: fast TTFT, highest throughput
//   glm-5.2         — solid mid-pack: slower TTFT, decent throughput
//   deepseek-v4-pro — slowest, and loses one of seven iterations to a 503
//                     (exercises the failed-run rendering in RunTimeline)
import { summarizeRuns } from '../core';
import type { BenchmarkReport, BenchRun } from '../core';
import type { BenchEntry, BenchLogEntry } from './context';

// Per-model shape spec: the raw run series is generated linearly from these
type RunSpec = {
    // Iteration count
    count: number;
    // Base / per-iteration step for TTFT (seconds)
    ttftBase: number;
    ttftStep: number;
    // Generation-phase base / step (seconds); totalTime = ttft + phase
    phaseBase: number;
    phaseStep: number;
    // Fixed token counts (kept constant per model for comparability)
    completionTokens: number;
    promptTokens: number;
    // When the i-th run starts after bench start (seconds, per iteration)
    startStep: number;
};

// Generates the raw run series for a model spec (pure, deterministic)
const buildRuns = (spec: RunSpec): BenchRun[] => {
    const runs: BenchRun[] = [];
    for (let i = 0; i < spec.count; i += 1) {
        const ttft = spec.ttftBase + i * spec.ttftStep;
        const phase = spec.phaseBase + i * spec.phaseStep;
        const totalTime = ttft + phase;
        const promptTokens = spec.promptTokens;
        const completionTokens = spec.completionTokens;
        runs.push({
            index: i,
            startTime: i * spec.startStep,
            ttft,
            totalTime,
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
        // ~4 chars per estimated token keeps contentLength coherent
        contentLength: completionTokens * 4,
        // The two speed metrics (input / output), same definitions as the
        // engine: prefill = prompt over TTFT, decode = completion over the
        // post-TTFT phase (ttft is always > 0 in these fixtures)
        prefillTokensPerSec: promptTokens / ttft,
        tokensPerSec: completionTokens / phase
        });
    }
    return runs;
};

// Wraps runs into a full report through the real summarizer (summary is exact)
const buildReport = (model: string, runs: BenchRun[], wallTime: number, createdAt: string, iterations: number): BenchmarkReport => ({
    model,
    config: { prompt: 'Write me 5000 words about yourself', iterations, concurrency: 1 },
    createdAt,
    wallTime,
    runs,
    // The SAME aggregation a live runBench() call would perform
    summary: summarizeRuns(model, runs, wallTime)
});

// ── The three fixture models (fixed timestamps keep snapshots stable) ──────
const FIXTURE_PROMPT = 'Write me 5000 words about yourself';

// Champion: quick first token, high sustained speed
const qwenRuns = buildRuns({ count: 6, ttftBase: 0.41, ttftStep: 0.03, phaseBase: 8.2, phaseStep: 0.12, completionTokens: 1148, promptTokens: 132, startStep: 9.1 });

// Mid-pack: noticeably slower first token, good throughput
const glmRuns = buildRuns({ count: 6, ttftBase: 0.52, ttftStep: 0.04, phaseBase: 8.6, phaseStep: 0.15, completionTokens: 1093, promptTokens: 132, startStep: 9.3 });

// Slowest model + one failed iteration (index 4) to exercise the red strip
const deepseekRuns = buildRuns({ count: 6, ttftBase: 0.66, ttftStep: 0.05, phaseBase: 9.4, phaseStep: 0.18, completionTokens: 1021, promptTokens: 132, startStep: 10.2 });
// Append the failed 7th attempt the engine recorded (503 upstream)
deepseekRuns.push({
    index: 6,
    startTime: 6 * 10.2,
    ttft: 0,
    totalTime: 1.84,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    contentLength: 0,
    prefillTokensPerSec: 0,
    tokensPerSec: 0,
    error: 'upstream 503: service unavailable'
});

/** Three fully consistent fixture reports (built through the real engine). */
export const sampleReports: BenchmarkReport[] = [
    buildReport('qwen3.8-27b', qwenRuns, 54.82, '2026-08-20T09:12:04.113Z', 6),
    buildReport('glm-5.2', glmRuns, 56.37, '2026-08-20T09:13:02.876Z', 6),
    buildReport('deepseek-v4-pro', deepseekRuns, 67.9, '2026-08-20T09:14:11.441Z', 7)
];

// Prompt the stories inject (matches the fixture reports' config)
export const samplePrompt = FIXTURE_PROMPT;

// A realistic console feed for the stories — oldest first (as the store appends)
export const sampleLogs: BenchLogEntry[] = [
    { id: 0, time: '09:12:00', text: 'start 6× "Write me 5000 words about yourself" @ qwen3.8-27b (concurrency 1)', tone: 'info' },
    { id: 1, time: '09:12:09', text: 'run 1/6 done in 8.63s (133.0 tok/s)', tone: 'info' },
    { id: 2, time: '09:12:18', text: 'run 2/6 done in 8.78s (131.9 tok/s)', tone: 'info' },
    { id: 3, time: '09:13:00', text: 'finish qwen3.8-27b: 6/6 ok, 132.4 tok/s avg', tone: 'success' },
    { id: 4, time: '09:13:32', text: 'run 5/7 done in 9.72s (105.0 tok/s)', tone: 'info' },
    { id: 5, time: '09:14:10', text: 'run 7/7 FAILED (upstream 503: service unavailable)', tone: 'error' },
    { id: 6, time: '09:14:11', text: 'finish deepseek-v4-pro: 6/7 ok, 104.2 tok/s avg', tone: 'success' }
];

// Console feed for the "Running" story: a bench in progress, nothing finished
export const runningLogs: BenchLogEntry[] = [
    { id: 0, time: '09:20:00', text: 'start 8× "Write me 5000 words about yourself" @ qwen3.8-27b (concurrency 4)', tone: 'info' },
    { id: 1, time: '09:20:14', text: 'run 1/8 done in 12.41s (92.5 tok/s)', tone: 'info' },
    { id: 2, time: '09:20:27', text: 'run 3/8 done in 11.82s (97.3 tok/s)', tone: 'info' }
];

// ── Benchmark entries (the model panels' run history) ────────────────────────
// The panel filters entries by the ACTIVE model, and the stories run against
// the OFFLINE demo fleet — so the fixture entries target the demo fleet's
// first model (echo-fast-27b, the rail's default selection) and reuse the
// fixture run series (renamed to the demo model) through the real summarizer.
const demoReport = (runs: BenchRun[], wallTime: number, createdAt: string, iterations: number): BenchmarkReport =>
    buildReport('echo-fast-27b', runs, wallTime, createdAt, iterations);

// A settled entry: 3/3 runs done (qwen series renamed → the demo champion)
const settledReport = demoReport(qwenRuns.slice(0, 3), 27.41, '2026-08-20T09:12:04.113Z', 3);

// A running entry: 2 of 3 runs settled, third in flight (partial report —
// exactly what the compiled scenario helper commits mid-run)
const runningReport = demoReport(qwenRuns.slice(0, 2), 0, '2026-08-20T09:20:00.000Z', 3);

// Live in-flight readout for the third run — what the engine's onStream
// ticks report mid-generation (output received so far, decode-phase rate,
// and the streamed words so far)
const runningStreams: BenchEntry['streaming'] = [
    {
        index: 2,
        chars: 4812,
        tokens: 1203,
        text: 'The keeper climbed the spiral stair with the lamp trimmed and burning, the sea pressing close against the rock below. Each night the same ritual, and each night the light answered the fog…',
        elapsed: 26.4,
        tokensPerSec: 45.6
    }
];

/** Fixture benchmark entries for the stories (newest first, store order). */
export const sampleEntries: BenchEntry[] = [
    {
        id: 'bench-2',
        model: 'echo-fast-27b',
        modelLabel: 'echo-fast-27b',
        scenarioId: 'short-story',
        scenarioLabel: 'Short Story',
        prompt: 'Write me a short story about a lighthouse keeper. Maximum of 1000 words.',
        iterations: 3,
        concurrency: 1,
        status: 'running',
        progress: { completed: 2, failed: 0, total: 3 },
        // Run 3 is mid-generation → its live "1,203 tok received" row shows
        streaming: runningStreams,
        report: runningReport
    },
    {
        id: 'bench-1',
        model: 'echo-fast-27b',
        modelLabel: 'echo-fast-27b',
        scenarioId: 'short-story',
        scenarioLabel: 'Short Story',
        prompt: 'Write me a short story about a lighthouse keeper. Maximum of 1000 words.',
        iterations: 3,
        concurrency: 1,
        status: 'done',
        progress: { completed: 3, failed: 0, total: 3 },
        report: settledReport
    }
];

/** Just the running entry (for the "Running" story). */
export const runningEntry: BenchEntry = sampleEntries[0];