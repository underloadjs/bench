// dashboard/framework/host.tsx — plugin HOST components (framework-side
// mounting surfaces).
//
// Every bench plugin automatically gets access to these slots once
// registered (see plugins/index.ts and registry.ts):
//
//   <BenchPluginRailHost>   — renders every loaded plugin's entries in
//                             registration order, wrapped in shared
//                             list-button chrome (icon chip + label +
//                             active state). Clicking an entry activates
//                             the owning plugin's panel via the store.
//   <BenchPluginToolbarHost> — renders the ACTIVE plugin's toolbar.
//   <BenchPluginPanelHost>   — renders the ACTIVE plugin's panel.
//
// All hosts subscribe to the shared store (useBenchDashboard), so selection
// changes and plugin mutations re-render exactly the hosts that care.
// Plugins NEVER import these — the framework host (BenchDashboard) does.
// This keeps the dependency direction one-way:
// framework → plugin contract ← plugin.
import React from 'react';
import { styledComponent } from '@presource/react';
import { DEFAULT_PROVIDER_URL } from '../../core';
import { useBenchDashboard } from '../context';
import { benchTheme } from '../utilities';
import type { BenchPlugin, BenchScenarioPlugin } from './types';

// Shared props for the slot hosts: the ordered plugin list from the registry
// plus the framework-injected run plumbing (loaded scenarios + external
// runner override) that flows into the panel's context.
export type BenchPluginHostProps = {
    plugins: BenchPlugin[];
    // The loaded scenario plugins — passed through to the panel's context
    // so the model panel can render its scenario dropdown + dispatch runs.
    scenarios?: BenchScenarioPlugin[];
    // EXTERNAL RUNNER override (the dashboard's onNewRun prop) — when set,
    // the panel's Run dispatches there instead of creating entries.
    onRun?: () => void;
};

// ── Rail host ─────────────────────────────────────────────────────────────────
// The unified left rail. Every loaded plugin contributes its entries here;
// entries keep a stable key of `${pluginId}:${entryId}` so React can track
// them even when plugins come and go. Plugins arrive ONE BY ONE (see
// loader.ts) — the rail grows as each lands.

// Rail button chrome shared by ALL plugins — the visual consistency layer
// (icon chip + label, indigo-tinted fill when active).
const RailButton = styledComponent<{ active: string }>('button', {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    flexShrink: 0,
    width: '100%',
    border: ({ active }) => (active === 'true' ? `1px solid ${benchTheme.accent}` : `1px solid ${benchTheme.border}`),
    borderRadius: 10,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: ({ active }) => (active === 'true' ? 600 : 500),
    textAlign: 'left',
    whiteSpace: 'nowrap',
    // selected rows get the accent tint — passed as a string so nothing
    // leaks into the DOM and no boolean attribute warning fires
    background: ({ active }) => (active === 'true' ? benchTheme.accentSoft : benchTheme.surface),
    color: ({ active }) => (active === 'true' ? benchTheme.accentInk : benchTheme.textSecondary),
    fontFamily: benchTheme.sansFont,
    transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
    overflow: 'hidden'
});

const RailIcon = styledComponent<{ active: string }>('span', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    flexShrink: 0,
    borderRadius: 8,
    fontSize: 13,
    userSelect: 'none',
    background: ({ active }) => (active === 'true' ? benchTheme.accent : benchTheme.accentSoft),
    color: ({ active }) => (active === 'true' ? benchTheme.onAccent : benchTheme.accentInk)
});

const RailLabel = styledComponent('span', {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis'
});

// Rail frame heading (mirrors the maths dashboard's SidebarHeading role)
export const RailHeading = styledComponent('h2', {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: benchTheme.textMuted,
    margin: '0 0 6px 0',
    fontFamily: benchTheme.sansFont,
    flexShrink: 0,
    width: '100%'
});

/** The unified plugin rail: every loaded plugin's entries, in order. */
export function BenchPluginRailHost({ plugins }: BenchPluginHostProps) {
    const bench = useBenchDashboard();
    const selectedId = bench.selectedPluginId ?? '';

    // Flat, ordered list of (plugin, entry) pairs across ALL plugins — this
    // IS the dashboard's list of bench tests. Registration order = UI order.
    const items = plugins.flatMap((plugin) => plugin.entries.map((entry) => ({ plugin, entry })));

    if (items.length === 0) return null;

    return (
        <>
            <RailHeading>{'Bench Tests'}</RailHeading>
            {items.map(({ plugin, entry }) => {
                const active = plugin.id === selectedId;
                return (
                    <RailButton
                        key={`${plugin.id}:${entry.id}`}
                        active={active ? 'true' : 'false'}
                        aria-label={entry.ariaLabel ?? entry.label}
                        aria-pressed={active}
                        // Rail click activates the owning plugin's panel.
                        // MUST go through the selectPlugin action — `bench`
                        // here is the useBenchDashboard() wrapper (snapshot
                        // reads only), so a direct `bench.selectedPluginId =
                        // ...` write would land on the wrapper and never
                        // reach the store proxy / trigger a refresh.
                        onClick={() => {
                            bench.selectPlugin(plugin.id);
                            // TARGET AUTOFILL — "clicking the left updates
                            // the two fields": a rail click snaps the
                            // panel's editable Model + Endpoint fields to
                            // this model's binding (store applyTarget).
                            // Re-clicks of the ALREADY-active entry re-sync
                            // too (the panel's mount effect only fires on
                            // activation; the panel mirrors the store
                            // change into its drafts). Non-model plugins
                            // carry no payload → skip.
                            if (entry.model) {
                                bench.applyTarget(entry.model, entry.endpoint ?? DEFAULT_PROVIDER_URL);
                            }
                            // MUST go through the selectPlugin action —
                            // `bench` here is the useBenchDashboard()
                            // wrapper (snapshot reads only), so a direct
                            // `bench.selectedPluginId = ...` write would
                            // land on the wrapper and never reach the store
                            // proxy / trigger a refresh.
                        }}
                    >
                        <RailIcon active={active ? 'true' : 'false'} aria-hidden="true">
                            {entry.icon ?? '·'}
                        </RailIcon>
                        <RailLabel>{entry.label}</RailLabel>
                    </RailButton>
                );
            })}
        </>
    );
}

// ── Toolbar host ──────────────────────────────────────────────────────────────
export function BenchPluginToolbarHost({ plugins }: BenchPluginHostProps) {
    const bench = useBenchDashboard();
    // Same resolution as useBenchPluginRegistry: the selected plugin,
    // falling back to the first registered one (e.g. first frame before the
    // reconcile layout-effect has fired).
    const active = plugins.find((p) => p.id === (bench.selectedPluginId ?? '')) ?? plugins[0];
    if (!active?.toolbar) return null;
    const Toolbar = active.toolbar;
    return (
        <Toolbar
            context={{
                pluginId: active.id,
                entryId: active.entries[0]?.id ?? '',
                entries: active.entries
            }}
        />
    );
}

// ── Panel host ────────────────────────────────────────────────────────────────
// Renders the ACTIVE plugin's panel. The panel's context carries the loaded
// scenario plugins + the external runner override so the model panel can
// render its run controls and dispatch benchmark entries itself.
export function BenchPluginPanelHost({ plugins, scenarios, onRun }: BenchPluginHostProps) {
    const bench = useBenchDashboard();
    const selectedId = bench.selectedPluginId ?? '';
    const active = plugins.find((p) => p.id === selectedId) ?? plugins[0];
    if (!active) return null;
    const Panel = active.panel;
    return (
        <Panel
            context={{
                pluginId: active.id,
                entryId: active.entries[0]?.id ?? '',
                entries: active.entries,
                scenarios,
                onRun
            }}
        />
    );
}
