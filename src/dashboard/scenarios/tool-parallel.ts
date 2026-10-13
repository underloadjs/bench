// dashboard/scenarios/tool-parallel.ts — the TOOL SELECTION benchmark scenario.
//
// A STANDALONE scenario plugin (see short-story.ts for the full contract):
// the tool-calling family's SELECTION probe. THREE tools are offered (the
// target calendar tool + two decoys) and the user request is phrased in
// natural language — the model must DISCRIMINATE the right tool, then fill
// all three of its required arguments. Latency profile: bigger prompt side
// (three schemas in the context) + a slightly longer decode than the
// single-tool baseline.
//
// The fixtures (schemas + prompt builder + expected call) live in
// ./tool-fixtures.ts — shared with the other tool-call variants.
import type { BenchScenarioFactory } from '../framework';
import { CALENDAR_EXPECTED_CALL, CALENDAR_PROMPT } from './tool-fixtures';

export const toolParallelScenario: BenchScenarioFactory = (bench) =>
    bench.createScenario({
        id: 'tool-parallel',
        label: 'Tool Selection',
        icon: '🎯',
        description: 'Pick the right tool from three offered — discrimination probe',
        // The exact fixture prompt (deterministic — see tool-fixtures.ts)
        prompt: CALENDAR_PROMPT,
        iterations: 2,
        concurrency: 1
    });

// Re-exported next to the scenario for discoverability: the canonical call
// the model's raw answer should match.
export { CALENDAR_EXPECTED_CALL as toolParallelExpectedAnswer };
