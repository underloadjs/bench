// dashboard/scenarios/brainstorm.ts — the BRAINSTORM benchmark scenario.
//
// A STANDALONE scenario plugin (see short-story.ts for the full contract):
// a list-generation probe that also exercises CONCURRENCY (2 iterations in
// flight at once) — the only scenario in the default set that stress-tests
// the provider's parallel request handling.
import type { BenchScenarioFactory } from '../framework';

export const brainstormScenario: BenchScenarioFactory = (bench) =>
    bench.createScenario({
        id: 'brainstorm',
        label: 'Brainstorm',
        icon: '💡',
        description: 'List generation with 2 concurrent iterations',
        prompt: 'Brainstorm 10 creative names for a small coffee shop by the sea.',
        iterations: 2,
        // The differentiator: 2 iterations in flight simultaneously
        concurrency: 2
    });
