// dashboard/framework/registry.ts — the bench plugin registry.
//
// REGISTRATION FLOW (mirrors distribution/maths/src/framework/registry.ts):
//
//   1. plugins/index.ts exports the ordered list of UNINVOKED plugin
//      factories (one bench plugin per test type / model).
//   2. useBenchPluginLoader (loader.ts) runs FIRST in the dashboard host:
//      the shell renders, then the factories are invoked one by one.
//   3. useBenchPluginRegistry(loadedPlugins) reconciles the ACTIVE plugin
//      with fallback: if the selection is empty or stale (plugin removed),
//      the first registered plugin is selected — the dashboard never
//      crashes on an empty/stale selection.
//
// Unlike the maths framework there are NO per-plugin store slices here:
// every bench plugin writes its output (reports/logs/status) into the ONE
// shared dashboard store (dashboard/context/store.ts), because the framework
// sections (leaderboard, timeline, console) render that output directly.
// Registry state is therefore just the selection pair.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useBenchDashboard } from '../context';
import type { BenchPlugin, BenchPluginId } from './types';

// What the registry hands back to the dashboard host.
export type BenchPluginRegistryResult = {
    // Plugins registered SO FAR (the loaded list, in order).
    plugins: BenchPlugin[];
    // The ACTIVE plugin (selection, falling back to the first registered).
    activePlugin: BenchPlugin | undefined;
};

// ── Host registry hook ────────────────────────────────────────────────────────
// Reconciles the active selection against the (growing) loaded plugin list
// and returns the stable ordered view the framework renders from.
export function useBenchPluginRegistry(plugins: BenchPlugin[]): BenchPluginRegistryResult {
    const bench = useBenchDashboard();

    // The selection lives in the shared store as selectedPluginId ('' =
    // nothing selected). Read through the proxy so selection writes by any
    // section (rail clicks) re-render this hook.
    const selectedId = bench.selectedPluginId ?? '';

    // Selection reconciliation: nothing selected yet, or the selected plugin
    // is no longer registered (removed mid-session / stale test state) →
    // select the FIRST registered plugin. useLayoutEffect so the corrected
    // selection is applied before the browser paints.
    const needsFallback = !selectedId || !plugins.some((p) => p.id === selectedId);
    useLayoutEffect(() => {
        if (needsFallback && plugins.length > 0) {
            // Go through the selectPlugin action: `bench` is the
            // useBenchDashboard() wrapper, so a direct property write would
            // land on the wrapper instead of the store proxy (no refresh).
            bench.selectPlugin(plugins[0].id);
        }
    }, [needsFallback, plugins, bench]);

    // Track ids ever seen so the "growing list" case never resets a live
    // selection (the loader appends one plugin at a time — the selected id
    // must survive each append).
    const seenRef = useRef<BenchPluginId[]>([]);
    useEffect(() => {
        seenRef.current = plugins.map((p) => p.id);
    }, [plugins]);

    // Stable ordered view for the framework to render. The eager ?? fallback
    // means even on the very first frame (before the layout effect above
    // fires) the host shows the first plugin rather than an empty canvas.
    return useMemo(() => {
        const activePlugin = plugins.find((p) => p.id === selectedId) ?? plugins[0];
        return { plugins, activePlugin };
    }, [plugins, selectedId]);
}

// ── Selection setter (plain action, not a hook) ──────────────────────────────
// Rail clicks / programmatic activation write through the shared store —
// the store proxy notifies every subscribed section. Kept as a standalone
// function so the host and tests can drive it without hook plumbing.
export function selectBenchPlugin(store: { selectedPluginId?: string }, pluginId: BenchPluginId) {
    store.selectedPluginId = pluginId;
}
