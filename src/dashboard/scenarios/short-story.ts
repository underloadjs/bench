// dashboard/scenarios/short-story.ts — the SHORT STORY benchmark scenario.
//
// A STANDALONE scenario plugin: one file, one factory, no imports outside
// the framework bundle. Removing this file and its line in ./index.ts
// removes the scenario from the RunBar dropdown without affecting the
// framework, the model fleet or any other scenario.
//
// The scenario only DESCRIBES the test; the framework compiles the helper
// (provider + store actions + progressive-feedback run loop) and passes it
// to the plugin's execute — see framework/scenario-kit.tsx.
import type { BenchScenarioFactory } from '../framework';

// Creative-writing probe: long-form generation, measured for sustained
// throughput (the generation phase dominates → tokensPerSec is meaningful).
// The prompt caps the story at 1000 words — long-form stays bounded, so a
// rambling model can never stall an iteration (the cap is prompt steering:
// same mechanism as summarization's "in one sentence" — the provider
// transport carries no max_tokens knob).
export const shortStoryScenario: BenchScenarioFactory = (bench) =>
    bench.createScenario({
        id: 'short-story',
        label: 'Short Story',
        icon: '📝',
        description: 'Long-form creative writing (max 1000 words) — sustained throughput probe',
        // 72 chars — under the runner's 80-char log slice, so console lines
        // show the whole prompt untruncated
        prompt: 'Write me a short story about a lighthouse keeper. Maximum of 1000 words.',
        // 3 sequential iterations keep the console narrative readable
        iterations: 3,
        concurrency: 1
    });
