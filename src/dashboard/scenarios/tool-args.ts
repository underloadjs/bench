// dashboard/scenarios/tool-args.ts — the NARROW-ARGS tool-call benchmark scenario.
//
// A STANDALONE scenario plugin (see short-story.ts for the full contract):
// the tool-calling family's ARG-FILLING stress probe. ONE tool is offered
// but with FIVE required arguments, including two enum-constrained string
// fields, a numeric weight, a strict YYYY-MM-DD date and a full address —
// the model must map a dense natural-language request onto every slot
// (parsing "overnight" → service enum, "FedEx" → carrier enum, "3.5 kg" →
// weightKg). Longest decode of the tool family: the call payload is the
// largest, while the offered-schema prompt stays small.
//
// The fixtures (schemas + prompt builder + expected call) live in
// ./tool-fixtures.ts — shared with the other tool-call variants.
import type { BenchScenarioFactory } from '../framework';
import { SHIPMENT_PROMPT, SHIPMENT_EXPECTED_CALL } from './tool-fixtures';

export const toolArgsScenario: BenchScenarioFactory = (bench) =>
    bench.createScenario({
        id: 'tool-args',
        label: 'Tool Args',
        icon: '📦',
        description: 'Five-slot structured call with enum/date constraints — arg-filling probe',
        // The exact fixture prompt (deterministic — see tool-fixtures.ts)
        prompt: SHIPMENT_PROMPT,
        iterations: 2,
        concurrency: 1
    });

// Re-exported next to the scenario for discoverability: the canonical call
// the model's raw answer should match.
export { SHIPMENT_EXPECTED_CALL as toolArgsExpectedAnswer };
