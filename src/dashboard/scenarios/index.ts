// dashboard/scenarios/index.ts — THE SCENARIO PLUGIN LIST — the single
// registration point for benchmark scenarios.
//
// Every scenario is a STANDALONE plugin: a factory FUNCTION that the
// dashboard loads by calling it with the framework bundle (BENCH_FRAMEWORK).
// Within each function the scenario describes its dropdown entry (label +
// prompt + iteration plan); the framework compiles the helper (target
// provider + store actions + progressive run loop) and hands it to the
// plugin's execute at dispatch time.
//
// This is the ONLY file that changes when adding or removing a scenario:
//
//   ADD     a scenario:  create dashboard/scenarios/<Name>.ts exporting the
//                        factory and add one line to the list below.
//   DELETE  a scenario:  delete its file and remove its line.
//                        Nothing else in the app references it.
//
// The list feeds the RunBar dropdown (components/modules/RunBar.tsx) — the
// New Run button sits NEXT TO the scenarios it dispatches, and every ticked
// scenario runs in one batch against the active model.
import type { BenchScenarioFactory } from '../framework';
import { shortStoryScenario } from './short-story';
import { summarizationScenario } from './summarization';
import { brainstormScenario } from './brainstorm';
import { growingContextScenario } from './growing-context';
import { toolCallScenario } from './tool-call';
import { toolParallelScenario } from './tool-parallel';
import { toolArgsScenario } from './tool-args';

// All installed scenario plugins, in dropdown order. UNINVOKED factories —
// the dashboard loads each one by calling it with its framework bundle.
// The tool-call family (single-tool / selection / narrow-args) sits after
// the text-probe set: baseline first, selection second, arg-stress last.
export const SCENARIOS: BenchScenarioFactory[] = [
    shortStoryScenario,
    summarizationScenario,
    brainstormScenario,
    growingContextScenario,
    toolCallScenario,
    toolParallelScenario,
    toolArgsScenario
];
