// dashboard/framework/loader.ts — progressive, post-render plugin loading.
//
// LOADING ORDER (mirrors distribution/maths/src/framework/loader.ts):
//
//   BEFORE: plugins/index.ts invoked every factory at MODULE LOAD time —
//           all plugins fully constructed before the dashboard rendered.
//
//   NOW:    PLUGINS stores the factories UNINVOKED. The dashboard renders
//           FIRST and then loads plugins in two stages:
//
//     1. WITH the first render: the first factory runs inside this hook's
//        useState initializer, so the shell chrome + the default bench
//        plugin are on screen in the very first paint.
//     2. AFTER mount (useEffect): the remaining factories run ONE BY ONE —
//        each load commits to state, then the loader yields to the browser
//        (macrotask via @presource/core's scriptPause) before constructing
//        the next plugin, so each one lands in its own frame and the rail
//        visibly grows.
//
// The loaded list is fed to useBenchPluginRegistry (registry.ts), which
// reconciles the active selection.
import { useEffect, useRef, useState } from 'react';
import { scriptPause } from '@presource/core';
import type { BenchFramework, BenchPluginFactory } from './framework';

// What the loader hands back to the dashboard host.
export type BenchPluginLoaderResult<T> = {
    // Plugins loaded SO FAR (grows one entry at a time until `done`).
    plugins: T[];
    // True once every factory in the list has been loaded.
    done: boolean;
};

// Load the plugin factories one by one, AFTER the dashboard has rendered.
//
// `factories` — the UNINVOKED plugin factories (model fleet from
//               plugins/index.ts OR scenario factories from scenarios/).
// `framework` — the framework bundle each factory is loaded with
//               (BENCH_FRAMEWORK).
//
// Generic over the produced plugin type: the model fleet produces
// BenchPlugin (rail entries), the scenario list produces BenchScenarioPlugin
// (dropdown entries) — both load through this one progressive mechanism.
export function useBenchPluginLoader<T>(
    factories: Array<(bench: BenchFramework) => T>,
    framework: BenchFramework
): BenchPluginLoaderResult<T> {
    // STAGE 1 — first plugin loads WITH the dashboard: the useState
    // initializer runs during the dashboard's very first render, so the
    // default bench is on screen immediately (no empty first frame).
    // StrictMode double-invokes initializers in dev — the factory is a pure
    // description builder, so the discarded duplicate is harmless.
    const [plugins, setPlugins] = useState<T[]>(() => (factories.length > 0 ? [factories[0](framework)] : []));

    // Mirror of the loaded count. WHY A REF: the load chain must know how
    // many factories are already loaded WITHOUT reading live state inside
    // setPlugins — and the FACTORY CALL must stay OUTSIDE the state updater,
    // because updaters must be pure (React StrictMode double-invokes them,
    // which would run a factory twice). The ref is re-synced from committed
    // state on every render.
    const loadedCountRef = useRef(plugins.length);
    loadedCountRef.current = plugins.length;

    // STAGE 2 — after mount, load the remaining plugins ONE BY ONE.
    useEffect(() => {
        // Cancellation flag: stops the chain when the host unmounts (RTL
        // cleanup, route change) or StrictMode simulates the unmount — the
        // re-run below restarts the chain from scratch.
        let stopped = false;

        // Load the factory at `index`, then yield to the browser before the
        // next one. The macrotask yield (scriptPause(0)) lets the browser
        // paint the newly loaded plugin between loads — that paint IS the
        // "one by one" behaviour.
        const loadFrom = (index: number) => {
            if (stopped || index >= factories.length) return;
            if (index < loadedCountRef.current) {
                // Already loaded (StrictMode remount re-walks the chain) —
                // skip forward without re-invoking the factory.
                scriptPause(0).then(() => loadFrom(index + 1));
                return;
            }
            // Build the plugin OUTSIDE the updater (updaters must stay
            // pure — see loadedCountRef above).
            const plugin = factories[index](framework);
            if (stopped) return;
            // Claim the index BEFORE committing, so a parallel chain
            // (StrictMode remount) that reaches this index later skips it.
            loadedCountRef.current = index + 1;
            setPlugins((prev) => (prev.length > index ? prev : [...prev, plugin]));
            scriptPause(0).then(() => loadFrom(index + 1));
        };

        // Index 0 is preloaded by the initializer above — start at 1.
        loadFrom(1);

        return () => {
            stopped = true;
        };
    }, [factories, framework]);

    return { plugins, done: plugins.length >= factories.length };
}
