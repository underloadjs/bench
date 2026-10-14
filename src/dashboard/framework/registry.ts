// dashboard/framework/registry.ts — the bench plugin registry.
//
// REGISTRATION FLOW (mirrors distribution/maths/src/framework/registry.ts):
//
//   1. plugins/index.ts exports the ordered list of UNINVOKED plugin
//      factories (one bench plugin per test type / model).
//   2. useBenchPluginLoader (loader.ts) runs FIRST in the dashboard host:
//      the shell renders, then the factories are invoked one by one.
//   3. useBenchPluginRegistry(loadedPlugins) reconciles the plugin
//      SELECTION (multi-select — every selected model renders as a column
//      and is benchmarked by one New Run) with fallback: if the selection is
//      empty because the operator has never touched it, the first registered
//      plugin is selected — a fresh dashboard is immediately runnable. Once
//      the operator toggles anything, the fallback stands down (a deliberate
//      deselect-all STICKS, exactly like the scenario dropdown's
//      defaultedForRef guard against forced re-ticks).
//
// Unlike the maths framework there are NO per-plugin store slices here:
// every bench plugin writes its output (reports/logs/status) into the ONE
// shared dashboard store (dashboard/context/store.ts), because the framework
// sections (leaderboard, timeline, console) render that output directly.
// Registry state is therefore just the selection list.
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useBenchDashboard } from '../context';
import type { BenchPlugin, BenchPluginId } from './types';

// What the registry hands back to the dashboard host.
export type BenchPluginRegistryResult = {
    // Plugins registered SO FAR (the loaded list, in order).
    plugins: BenchPlugin[];
    // The FIRST selected plugin (display/debug surfaces; the columns area
    // renders every selected plugin).
    activePlugin: BenchPlugin | undefined;
};

// ── Host registry hook ────────────────────────────────────────────────────────
// Reconciles the selection list against the (growing) loaded plugin list and
// returns the stable ordered view the framework renders from.
export function useBenchPluginRegistry(plugins: BenchPlugin[]): BenchPluginRegistryResult {
    const bench = useBenchDashboard();

    // The selection lives in the shared store as selectedPluginIds. Read
    // through the proxy so selection writes by any section (rail toggles)
    // re-render this hook.
    const selectedIds = bench.selectedPluginIds ?? [];

    // PRUNE: ids that are no longer registered (removed mid-session / stale
    // fleet swap) drop out of the selection.
    const liveIds = selectedIds.filter((id) => plugins.some((plugin) => plugin.id === id));

    // DEFAULT-ONCE: nothing selected + the operator never toggled + plugins
    // loaded → select the FIRST registered plugin. useLayoutEffect so the
    // corrected selection is applied before the browser paints.
    const needsDefault = selectedIds.length === 0 && !bench.modelSelectionTouched && plugins.length > 0;
    const needsPrune = liveIds.length !== selectedIds.length && liveIds.length > 0;

    useLayoutEffect(() => {
        // Go through the selectPlugins action: `bench` is the
        // useBenchDashboard() wrapper, so a direct property write would land
        // on the wrapper instead of the store proxy (no refresh).
        if (needsPrune) {
            bench.selectPlugins(liveIds);
        } else if (needsDefault) {
            bench.selectPlugins([plugins[0].id]);
        }
    }, [needsPrune, needsDefault, plugins, bench]);

    // Stable ordered view for the framework to render. The eager ?? fallback
    // means even on the very first frame (before the layout effect above
    // fires) display surfaces resolve rather than sit empty.
    return useMemo(() => {
        const activePlugin = plugins.find((plugin) => plugin.id === selectedIds[0]) ?? plugins[0];
        return { plugins, activePlugin };
    }, [plugins, selectedIds[0]]);
}

// ── Selection setter (plain action, not a hook) ──────────────────────────────
// Programmatic activation writes through the shared store — the store proxy
// notifies every subscribed section. Kept as a standalone function so the
// host and tests can drive it without hook plumbing.
export function selectBenchPlugins(store: { selectedPluginIds?: string[] }, pluginIds: BenchPluginId[]) {
    store.selectedPluginIds = [...pluginIds];
}
