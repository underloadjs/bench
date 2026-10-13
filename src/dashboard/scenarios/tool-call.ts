// dashboard/scenarios/tool-call.ts — the SINGLE-TOOL CALL benchmark scenario.
//
// A STANDALONE scenario plugin (see short-story.ts for the full contract):
// the tool-calling family's baseline probe. ONE tool is offered with two
// required arguments; the model must answer with a raw JSON tool call.
// Isolates STRUCTURED-ARGUMENT EMISSION without a selection burden — the
// shortest latency profile of the tool family (small prompt, tiny decode).
//
// The fixtures (schemas + prompt builder + expected call) live in
// ./tool-fixtures.ts — shared with the other tool-call variants so all
// variants share the identical response contract.
import type { BenchScenarioFactory } from '../framework';
import { WEATHER_EXPECTED_CALL, WEATHER_PROMPT } from './tool-fixtures';

export const toolCallScenario: BenchScenarioFactory = (bench) =>
    bench.createScenario({
        id: 'tool-call',
        label: 'Tool Call',
        icon: '🛠️',
        description: 'Single-tool JSON call emission — structured output probe',
        // The exact fixture prompt (deterministic — see tool-fixtures.ts)
        prompt: WEATHER_PROMPT,
        // Tiny completions → 2 iterations keep the run quick, matching the
        // summarization probe's shape
        iterations: 2,
        concurrency: 1
    });

// Re-exported next to the scenario for discoverability: tests and future
// scorers compare the model's raw answer against this canonical call.
export { WEATHER_EXPECTED_CALL as toolCallExpectedAnswer };
