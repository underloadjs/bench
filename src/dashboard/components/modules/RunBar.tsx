// dashboard/components/modules/RunBar.tsx — the RUN CONTROL row.
//
// Lives INSIDE the model panel, directly under the model name:
//
//   <model name>
//   [ ▾ Short Story ] [3 ▾ iterations] [1 ▾ concurrency] [ New Run ]
//   <scenario description + prompt>
//   ────────────────────────────────
//   <benchmark entries, newest first>
//
// The dropdown lists every loaded SCENARIO plugin (dashboard/scenarios/) —
// tick several to benchmark them TOGETHER in one click. The two selects pin
// the run plan (load-test semantics, k6 vus × iterations style):
//
//   Iterations  = runs each bench entry executes (sequential within it)
//   Concurrency = how many bench entries generate side-by-side (LANES) —
//                 concurrency 3 + New Run → 3 parallel bench cards appear
//
// onRun emits the pinned plan; the panel owns the actual fan-out launching
// (framework/model-kit.tsx handleRun → framework/scenario-kit.ts
// launchScenario).
import React, { useEffect, useRef, useState } from 'react';
import { styledComponent } from '@presource/react';
import { benchTheme } from '../../utilities';
// NOTE: the ACTIONS hook (useBenchDashboard), not the raw benchDashboardStore()
// — the raw store is the context snapshot (reads only); ticking scenarios and
// default-selecting must go through the intent-named actions.
import { useBenchDashboard } from '../../context';
import type { BenchScenarioSpec } from '../../framework';

export type RunBarProps = {
    // The loaded scenario SPECS (registration order = dropdown order).
    scenarios: BenchScenarioSpec[];
    // Dispatches a run batch with the pinned plan (panel → launchScenario).
    onRun: (plan: { iterations: number; concurrency: number }) => void;
};

// Numeric bounds for the plan inputs (clamped on change AND at emit time —
// the engine re-sanitizes too, see resolvePlan in framework/scenario-kit.ts)
const MAX_ITERATIONS = 50;
const MAX_CONCURRENCY = 16;

// The row: dropdown + plan inputs + run button on one line, RIGHT-ALIGNED —
// the run configuration belongs to the operator's eye corner of the panel
const RunBarShell = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    flexShrink: 0,
    minWidth: 0,
    width: '100%',
    flexWrap: 'wrap'
});

// Wrapper around the dropdown button + menu (anchors the absolute menu)
const DropdownShell = styledComponent('div', {
    position: 'relative',
    flexShrink: 0
});

// The dropdown trigger: chip-styled button with a caret
const DropdownButton = styledComponent('button', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    background: benchTheme.surface,
    border: `1px solid ${benchTheme.border}`,
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: benchTheme.sansFont,
    color: benchTheme.textPrimary,
    cursor: 'pointer',
    maxWidth: 320,
    minWidth: 0
});

// Selected-label text inside the trigger (ellipsised when long)
const DropdownLabel = styledComponent('span', {
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis'
});

// Caret glyph — flips via the `flipped` prop. NOTE the prop is NOT named
// `open`: that is a real HTML attribute (details/dialog) and React forwards
// the string form onto the DOM span with a warning ("Received the string
// `false` for the boolean attribute `open`"); a non-attribute name stays
// DOM-clean (same reasoning as MenuItem's `ticked` prop below).
const DropdownCaret = styledComponent<{ flipped: string }>('span', {
    fontSize: 10,
    color: benchTheme.textMuted,
    transform: ({ flipped }) => (flipped === 'true' ? 'rotate(180deg)' : 'none'),
    transition: 'transform 0.15s ease'
});

// Transparent click-away catcher under the open menu (closes without any
// global listener plumbing — clicking anywhere outside the menu hits this)
const ClickAway = styledComponent('div', {
    position: 'fixed',
    inset: 0,
    zIndex: 30,
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'default'
});

// The floating menu listing the scenarios with tick markers
const Menu = styledComponent('div', {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    zIndex: 40,
    minWidth: 260,
    background: benchTheme.surface,
    border: `1px solid ${benchTheme.border}`,
    borderRadius: 10,
    boxShadow: benchTheme.shadow,
    padding: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 2
});

// One scenario row: tick chip + icon + label (+ muted description tooltip).
// NOTE the styled prop is `ticked`, NOT `selected` — `selected` is a real
// (boolean) HTML attribute and React forwards the string form onto the DOM
// button with a warning ("Received the string `true` for the boolean
// attribute `selected`"); a non-attribute name stays DOM-clean.
const MenuItem = styledComponent<{ ticked: string }>('button', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px',
    border: 'none',
    borderRadius: 7,
    fontSize: 13,
    fontWeight: ({ ticked }) => (ticked === 'true' ? 600 : 500),
    fontFamily: benchTheme.sansFont,
    textAlign: 'left',
    cursor: 'pointer',
    background: ({ ticked }) => (ticked === 'true' ? benchTheme.accentSoft : 'transparent'),
    color: ({ ticked }) => (ticked === 'true' ? benchTheme.accentInk : benchTheme.textSecondary)
});

// Tick marker column (check glyph when ticked, blank otherwise)
const MenuTick = styledComponent<{ ticked: string }>('span', {
    width: 16,
    flexShrink: 0,
    fontSize: 12,
    color: benchTheme.accentInk,
    visibility: ({ ticked }) => (ticked === 'true' ? 'visible' : 'hidden')
});

// Plan input: compact label + native <input type="number"> in a bordered
// chip. styledComponent's typed surface lacks input props → cast (UrlInput
// pattern in src/App.tsx).
const PlanField = styledComponent('label', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0
});

const PlanLabel = styledComponent('span', {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont
});

const PlanInput = styledComponent('input', {
    width: 56,
    padding: '7px 8px',
    background: benchTheme.surface,
    border: `1px solid ${benchTheme.border}`,
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: benchTheme.monoFont,
    color: benchTheme.textPrimary,
    textAlign: 'center',
    outline: 'none'
}) as unknown as React.ForwardRefExoticComponent<
    React.InputHTMLAttributes<HTMLInputElement> & { theme?: any; [breakpoint: string]: any }
>;

// Parses + clamps a number-input draft: blank/invalid → the fallback, out-of-
// range → the nearest bound. Keeps the state a clean integer at all times.
const clampPlanValue = (raw: string, max: number, fallback: number): number => {
    const parsed = Math.floor(Number(raw));
    if (Number.isNaN(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, max);
};

// Primary run button — the batch dispatcher
const RunButton = styledComponent('button', {
    background: benchTheme.accent,
    color: benchTheme.onAccent,
    border: 'none',
    borderRadius: 8,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: benchTheme.sansFont,
    cursor: 'pointer',
    flexShrink: 0
});

/** Run control row: scenario multi-select + plan selects + New Run. */
export const RunBar = React.memo((props: RunBarProps) => {
    const { scenarios, onRun } = props;

    // Local open/close state for the dropdown menu
    const [open, setOpen] = useState(false);

    // Shared store: the ticked scenarios + the DURABLE run plan
    const bench = useBenchDashboard();
    const { selectedScenarioIds } = bench;

    // The pinned plan (iterations / concurrency) — LOCAL DRAFTS seeded from
    // the shared store. The store is the plan's durable home: a rail switch
    // UNMOUNTS this panel and mounts the next model's, so RunBar-local state
    // alone would reset the operator's plan (the reported bug). Drafts +
    // write-through on every change keep typing snappy (store writes fire a
    // DEFERRED refresh — see the target-field rationale in
    // framework/model-kit.tsx) while every fresh mount seeds from the
    // persisted values, so Scenarios/Iterations/Concurrency survive across
    // ANY model selected on the left.
    const [iterations, setIterations] = useState(bench.planIterations);
    const [concurrency, setConcurrency] = useState(bench.planConcurrency);

    // The primary scenario drives the plan defaults shown in the inputs
    const primary = scenarios.find((scenario) => selectedScenarioIds.includes(scenario.id)) ?? scenarios[0];

    // DEFAULT SELECTION — APPLIED ONCE: nothing ticked yet + scenarios loaded
    // → tick the first one so the dropdown (and the run it dispatches) is
    // never empty on a fresh dashboard.
    //
    // REGRESSION GUARD (ref): this effect's deps (`scenarios` and
    // `selectedScenarioIds` are fresh proxy objects, `bench` a fresh wrapper
    // — new identity every render) re-ran it after EVERY render, and each
    // re-run with an empty selection RE-ASSERTED `[scenarios[0].id]`. That
    // made the first scenario a forced, unde-tickable choice: unticking it
    // (or clearing the selection) instantly re-ticked it, so the dropdown
    // fought every operator change. The ref pins the default to the scenario
    // SET that produced it — user changes always win afterwards.
    const defaultedForRef = useRef<string | null>(null);
    useEffect(() => {
        if (scenarios.length > 0 && selectedScenarioIds.length === 0 && defaultedForRef.current !== scenarios[0].id) {
            defaultedForRef.current = scenarios[0].id;
            bench.selectScenarios([scenarios[0].id]);
        }
    }, [scenarios, selectedScenarioIds, bench]);

    // Operator-edited flag for the plan inputs: the moment the operator types
    // into either input, the pinned plan is THEIRS — scenario-spec auto-sync
    // below must stop touching it. LIVES IN THE STORE (planPinned), not a
    // local ref: the local ref reset on every panel remount (model switch),
    // so a persisted plan would be clobbered back to the spec by this very
    // effect on the next model's first render.
    const planPinned = bench.planPinned;

    // Follow the primary scenario's spec while the inputs are UNTOUCHED (the
    // inputs show the plan the scenario was authored with). Writes go to BOTH
    // the local drafts (what the inputs show) and the store (what a remount
    // seeds from).
    //
    // REGRESSION GUARD: this effect used to resync on EVERY primary change —
    // including changes caused by ticking/unticking scenarios — silently
    // CLOBBERING the operator's typed iterations/concurrency (e.g. set
    // concurrency 4, then untick the primary scenario → inputs snap back to
    // the spec's concurrency 1 → the run executes sequentially and
    // "concurrency isn't working"). Once the plan is pinned (store flag),
    // the typed plan persists across any selection change — and across
    // model switches too.
    useEffect(() => {
        if (primary && !planPinned) {
            const specIterations = primary.iterations ?? 3;
            const specConcurrency = primary.concurrency ?? 1;
            setIterations(specIterations);
            setConcurrency(specConcurrency);
            bench.setPlan(specIterations, specConcurrency);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync only when the primary scenario itself changes
    }, [primary?.id]);

    return (
        <RunBarShell>
            <DropdownShell>
                {/* The scenario dropdown trigger — sits directly LEFT of the
                    New Run button ("the new run next to the scenarios") */}
                <DropdownButton
                    data-testid="bench-scenario-dropdown"
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    // NOTE: must NOT start with "Benchmark " — the rail buttons
                    // use `aria-label="Benchmark <model>"` and the App test
                    // selects them with a ^= prefix matcher
                    aria-label="Pick benchmark scenarios"
                    onClick={() => setOpen(!open)}
                >
                    <DropdownLabel>{dropdownLabel(scenarios, selectedScenarioIds)}</DropdownLabel>
                    <DropdownCaret flipped={open ? 'true' : 'false'} aria-hidden="true">
                        {'▾'}
                    </DropdownCaret>
                </DropdownButton>

                {/* Click-away catcher + floating menu while open */}
                {open ? (
                    <React.Fragment>
                        <ClickAway data-testid="bench-dropdown-clickaway" onClick={() => setOpen(false)} />
                        <Menu role="listbox" aria-label="Benchmark scenarios" aria-multiselectable="true">
                            {scenarios.map((scenario) => {
                                const selected = selectedScenarioIds.includes(scenario.id);
                                return (
                                    <MenuItem
                                        key={scenario.id}
                                        role="option"
                                        aria-selected={selected}
                                        title={scenario.description ?? scenario.label}
                                        ticked={selected ? 'true' : 'false'}
                                        onClick={() => {
                                            bench.toggleScenario(scenario.id);
                                        }}
                                    >
                                        <MenuTick ticked={selected ? 'true' : 'false'} aria-hidden="true">
                                            {'✓'}
                                        </MenuTick>
                                        <span aria-hidden="true">{scenario.icon ?? '·'}</span>
                                        <span>{scenario.label}</span>
                                    </MenuItem>
                                );
                            })}
                        </Menu>
                    </React.Fragment>
                ) : null}
            </DropdownShell>

            {/* Pinned plan: iterations per entry + parallelism inside the
                run — NUMBER inputs (free count, clamped), not dropdowns */}
            <PlanField>
                <PlanLabel>{'Iterations'}</PlanLabel>
                <PlanInput
                    data-testid="bench-iterations-input"
                    type="number"
                    min={1}
                    max={MAX_ITERATIONS}
                    aria-label="Iterations per benchmark"
                    value={iterations}
                    onChange={(event) => {
                        // Operator typed → the plan is pinned by hand from now
                        // on (persisted in the store so the pin survives
                        // panel remounts — model switches — and scenario-spec
                        // auto-sync stands down), then written through so the
                        // next panel seeds from the same value
                        bench.pinPlan();
                        const next = clampPlanValue(event.target.value, MAX_ITERATIONS, 1);
                        setIterations(next);
                        bench.setPlanIterations(next);
                    }}
                />
            </PlanField>
            <PlanField>
                <PlanLabel>{'Concurrency'}</PlanLabel>
                <PlanInput
                    data-testid="bench-concurrency-input"
                    type="number"
                    min={1}
                    max={MAX_CONCURRENCY}
                    // Concurrency = PARALLEL BENCH LANES: 3 → three bench
                    // entries generate side-by-side (each showing its own
                    // card + progress), not iterations inside one entry
                    aria-label="Parallel benchmarks"
                    value={concurrency}
                    onChange={(event) => {
                        // Operator typed → never clobbered by scenario-spec
                        // auto-sync again (the "concurrency reverts to 1"
                        // bug); the pin + value persist in the store across
                        // model switches
                        bench.pinPlan();
                        const next = clampPlanValue(event.target.value, MAX_CONCURRENCY, 1);
                        setConcurrency(next);
                        bench.setPlanConcurrency(next);
                    }}
                />
            </PlanField>

            {/* THE DISPATCH: one entry per ticked scenario, all launched in
                parallel (panel handler → launchScenario) */}
            <RunButton
                onClick={() => {
                    setOpen(false);
                    onRun({ iterations, concurrency });
                }}
                aria-label="Start a new benchmark run"
            >
                {'New Run'}
            </RunButton>
        </RunBarShell>
    );
});

// Trigger label — makes the MULTI-SELECTION legible at a glance:
//   0 ticked  → 'Scenarios' (the dispatcher falls back to the first)
//   1 ticked  → its label ("Short Story")
//   N ticked  → first label + the extra count ("Short Story +2") — the
//               full tick set stays visible as ✓ markers in the open menu
const dropdownLabel = (scenarios: BenchScenarioSpec[], selectedIds: string[]): string => {
    const labels = scenarios.filter((scenario) => selectedIds.includes(scenario.id)).map((scenario) => scenario.label);
    if (labels.length === 0) return 'Scenarios';
    if (labels.length === 1) return labels[0];
    return `${labels[0]} +${labels.length - 1}`;
};
