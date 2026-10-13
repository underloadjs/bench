// dashboard/scenarios/summarization.ts — the SUMMARIZATION benchmark scenario.
//
// A STANDALONE scenario plugin (see short-story.ts for the full contract):
// a compression probe — short responses, so TTFT dominates the reading.
import type { BenchScenarioFactory } from '../framework';

// Fixed input passage so every model receives the identical payload
const PASSAGE =
    'The lighthouse stood at the edge of the peninsula for over a century, its lamp guiding fishing boats through fog and winter storms. Keepers kept rotating shifts to tend the wick, log the weather, and signal passing vessels, until automation replaced the last keeper in 1968.';

export const summarizationScenario: BenchScenarioFactory = (bench) =>
    bench.createScenario({
        id: 'summarization',
        label: 'Summarization',
        icon: '📄',
        description: 'Compress a fixed passage — first-token latency probe',
        prompt: `Summarize the following passage in one sentence:\n\n${PASSAGE}`,
        // Short completions → 2 iterations keep the run quick
        iterations: 2,
        concurrency: 1
    });
