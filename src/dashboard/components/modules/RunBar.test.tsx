// dashboard/components/modules/RunBar.test.tsx — run-control interaction tests.
//
// Covers the two reported defects and the multi-select contract:
//
//   1. MULTI-SELECT: ticking a second scenario must KEEP the first ticked
//      (one entry each on New Run — all launched in parallel). The trigger
//      label names the first tick + the extra count so a multi-selection is
//      legible without opening the menu.
//   2. NO FORCED RE-TICK: the first-scenario default is applied ONCE. The old
//      effect re-asserted `[scenarios[0].id]` on every render with an empty
//      selection (fresh proxy identities in the deps), which made the first
//      scenario unde-tickable — unticking it instantly re-ticked it.
//   3. PLAN PERSISTENCE: once the operator types into the iterations or
//      concurrency input, scenario-spec auto-sync must stand down. The old
//      effect resynced on EVERY primary-scenario change, silently clobbering
//      a typed concurrency back to the spec's 1 → runs executed sequentially
//      ("concurrency isn't working").
//   4. The New Run dispatch emits the EXACT typed plan.
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BenchContextProvider } from '../../context';
import type { BenchScenarioSpec } from '../../framework';
import { RunBar, type RunBarProps } from './RunBar';

// Three specs with DISTINCT authored plans so spec-sync vs operator-edits are
// distinguishable. Gamma omits both plan fields (exercises the 3/1 defaults).
const specs: BenchScenarioSpec[] = [
    { id: 'alpha', label: 'Alpha', icon: '🅰', prompt: 'p-alpha', iterations: 3, concurrency: 1 },
    { id: 'beta', label: 'Beta', icon: '🅱', prompt: 'p-beta', iterations: 2, concurrency: 2 },
    { id: 'gamma', label: 'Gamma', icon: '🇬', prompt: 'p-gamma' }
];

// Flushes the store's DEFERRED refresh (context/store.ts triggerRefresh uses
// setTimeout) and the re-render it schedules.
const flush = async () => {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
};

// Renders the RunBar inside its required reactive context scope.
const renderRunBar = (onRun: (plan: { iterations: number; concurrency: number }) => void) =>
    render(
        <BenchContextProvider>
            <RunBar scenarios={specs} onRun={onRun} />
        </BenchContextProvider>
    );

// Opens the floating scenario menu.
const openMenu = async () => {
    await act(async () => {
        screen.getByTestId('bench-scenario-dropdown').click();
    });
    await flush();
};

// The dropdown menu option for one scenario label.
const option = (label: string) => screen.getByRole('option', { name: new RegExp(label) }) as HTMLButtonElement;

// The plan inputs (cast: styledComponent's typed surface hides input props).
const iterationsInput = () => screen.getByTestId('bench-iterations-input') as HTMLInputElement;
const concurrencyInput = () => screen.getByTestId('bench-concurrency-input') as HTMLInputElement;

describe('RunBar', () => {
    it('defaults to the first scenario ticked on a fresh dashboard', async () => {
        renderRunBar(vi.fn());
        await flush();
        await openMenu();

        expect(option('Alpha').getAttribute('aria-selected')).toBe('true');
        expect(option('Beta').getAttribute('aria-selected')).toBe('false');
        expect(option('Gamma').getAttribute('aria-selected')).toBe('false');
        // Single tick → the trigger names it
        expect(screen.getByTestId('bench-scenario-dropdown').textContent).toContain('Alpha');

        cleanup();
    });

    it('supports multi-select: ticking a scenario keeps the previous ticks', async () => {
        renderRunBar(vi.fn());
        await flush();
        await openMenu();

        // Tick Beta (Alpha stays ticked from the default)
        await act(async () => {
            option('Beta').click();
        });
        await flush();

        expect(option('Alpha').getAttribute('aria-selected')).toBe('true');
        expect(option('Beta').getAttribute('aria-selected')).toBe('true');
        expect(option('Gamma').getAttribute('aria-selected')).toBe('false');
        // Multi tick → first label + extra count (legible multi-selection)
        expect(screen.getByTestId('bench-scenario-dropdown').textContent).toContain('Alpha +1');

        // Tick Gamma too — three-way multi-select
        await act(async () => {
            option('Gamma').click();
        });
        await flush();

        expect(option('Alpha').getAttribute('aria-selected')).toBe('true');
        expect(option('Beta').getAttribute('aria-selected')).toBe('true');
        expect(option('Gamma').getAttribute('aria-selected')).toBe('true');
        expect(screen.getByTestId('bench-scenario-dropdown').textContent).toContain('Alpha +2');

        cleanup();
    }, 10000);

    it('applies the first-scenario default ONCE — unticking it does not re-tick it', async () => {
        renderRunBar(vi.fn());
        await flush();

        // Untick the default-ticked first scenario → the selection must be
        // allowed to go (and stay) empty. The old behaviour re-asserted
        // [scenarios[0].id] after every render with an empty selection.
        await openMenu();
        await act(async () => {
            option('Alpha').click();
        });
        // Flush MULTIPLE deferred-refresh cycles — the forced re-tick used to
        // land one refresh AFTER the first, so a single flush masked it
        await flush();
        await flush();
        await flush();

        expect(option('Alpha').getAttribute('aria-selected')).toBe('false');
        expect(screen.getByTestId('bench-scenario-dropdown').textContent).toContain('Scenarios');

        // A later scenario load (spec set grows) must not resurrect a default
        // over the operator's empty selection either — the default is pinned
        // to the scenario set it was applied for
        await act(async () => {
            option('Beta').click();
        });
        await flush();
        await flush();

        expect(option('Beta').getAttribute('aria-selected')).toBe('true');
        expect(option('Alpha').getAttribute('aria-selected')).toBe('false');

        cleanup();
    }, 10000);

    it('keeps operator-typed plan values when the primary scenario changes', async () => {
        renderRunBar(vi.fn());
        await flush();

        // The operator pins a plan FIRST (the natural bench setup order)
        await act(async () => {
            fireEvent.change(concurrencyInput(), { target: { value: '4' } });
        });
        await act(async () => {
            fireEvent.change(iterationsInput(), { target: { value: '8' } });
        });
        await flush();

        // …then re-shapes the selection so the PRIMARY scenario changes
        // (untick Alpha → the next ticked one, Beta, becomes primary)
        await openMenu();
        await act(async () => {
            option('Beta').click();
        });
        await act(async () => {
            option('Alpha').click();
        });
        await flush();

        // REGRESSION: the old auto-sync reset both inputs to Beta's spec
        // (2 iterations / concurrency 1) — silently turning the pinned
        // concurrency-4 run into a sequential one
        expect(concurrencyInput().value).toBe('4');
        expect(iterationsInput().value).toBe('8');
        // Beta is now the only ticked scenario (the new primary)
        expect(option('Beta').getAttribute('aria-selected')).toBe('true');
        expect(option('Alpha').getAttribute('aria-selected')).toBe('false');

        cleanup();
    }, 10000);

    it('emits the exact typed plan on New Run', async () => {
        const onRun = vi.fn();
        renderRunBar(onRun);
        await flush();

        await act(async () => {
            fireEvent.change(iterationsInput(), { target: { value: '5' } });
        });
        await act(async () => {
            fireEvent.change(concurrencyInput(), { target: { value: '4' } });
        });
        await flush();

        await act(async () => {
            screen.getByRole('button', { name: 'Start a new benchmark run' }).click();
        });

        expect(onRun).toHaveBeenCalledTimes(1);
        expect(onRun).toHaveBeenCalledWith({ iterations: 5, concurrency: 4 });

        cleanup();
    }, 10000);

    it('syncs plan inputs from the scenario spec while the operator has not typed', async () => {
        renderRunBar(vi.fn());
        await flush();

        // Untouched inputs show the primary scenario's authored plan
        expect(iterationsInput().value).toBe('3');
        expect(concurrencyInput().value).toBe('1');

        // The primary only changes when the CURRENT primary leaves the tick
        // set: tick Beta, then untick Alpha → Beta (spec 2 iters / conc 2)
        // becomes the primary and the untouched inputs follow its spec
        await openMenu();
        await act(async () => {
            option('Beta').click();
        });
        await act(async () => {
            option('Alpha').click();
        });
        await flush();

        expect(iterationsInput().value).toBe('2');
        expect(concurrencyInput().value).toBe('2');

        cleanup();
    }, 10000);

    // ── CROSS-MODEL PERSISTENCE ──────────────────────────────────────────
    // The real dashboard keeps ONE BenchContextProvider mounted while the
    // rail switches models — each model's panel (and its RunBar) UNMOUNTS
    // and the next model's mounts. A RunBar-local plan (the old useState)
    // reset on every switch; the store-backed plan must survive.
    //
    // Test harness: a host holding the "active model" in state and keying
    // the RunBar by it. Keying forces a full unmount/remount of the RunBar
    // (exactly what the columns host does across selection changes: model
    // columns mount and unmount) while the
    // provider — and with it the store — stays mounted. NOTE: the host must
    // own the switch state (not a rerender from the test): a plain rerender
    // would give the provider new children identity and re-create the whole
    // context, wiping the store.
    const ModelSwitchHost = ({ onRun }: { onRun: RunBarProps['onRun'] }) => {
        // Two "models" — the key swap simulates the rail click
        const models = ['model-a', 'model-b'];
        const [active, setActive] = useState(0);
        return (
            <>
                <button data-testid="switch-model" onClick={() => setActive((index) => (index + 1) % models.length)}>
                    {'switch model'}
                </button>
                <RunBar key={models[active]} scenarios={specs} onRun={onRun} />
            </>
        );
    };

    it('persists the typed plan across a model switch (panel remount)', async () => {
        const onRun = vi.fn();
        render(
            <BenchContextProvider>
                <ModelSwitchHost onRun={onRun} />
            </BenchContextProvider>
        );
        await flush();

        // The operator pins a plan while benchmarking model A
        await act(async () => {
            fireEvent.change(iterationsInput(), { target: { value: '7' } });
        });
        await act(async () => {
            fireEvent.change(concurrencyInput(), { target: { value: '3' } });
        });
        await flush();

        // Switch to model B — a fresh RunBar mounts inside the SAME provider
        await act(async () => {
            screen.getByTestId('switch-model').click();
        });
        await flush();

        // REGRESSION: RunBar-local state reset both inputs to the spec
        // defaults (3/1) on every model switch — the persisted plan now
        // seeds the fresh panel instead
        expect(iterationsInput().value).toBe('7');
        expect(concurrencyInput().value).toBe('3');

        // The persisted plan is what the dispatch emits on the new model
        await act(async () => {
            screen.getByRole('button', { name: 'Start a new benchmark run' }).click();
        });
        expect(onRun).toHaveBeenCalledWith({ iterations: 7, concurrency: 3 });

        cleanup();
    }, 10000);

    it('persists the scenario selection across a model switch (panel remount)', async () => {
        const onRun = vi.fn();
        render(
            <BenchContextProvider>
                <ModelSwitchHost onRun={onRun} />
            </BenchContextProvider>
        );
        await flush();

        // Tick a second scenario on model A (default Alpha stays ticked)
        await openMenu();
        await act(async () => {
            option('Beta').click();
        });
        await flush();

        // Switch to model B
        await act(async () => {
            screen.getByTestId('switch-model').click();
        });
        await flush();
        await openMenu();

        // The tick set carried over: Alpha + Beta ticked, Gamma not
        expect(option('Alpha').getAttribute('aria-selected')).toBe('true');
        expect(option('Beta').getAttribute('aria-selected')).toBe('true');
        expect(option('Gamma').getAttribute('aria-selected')).toBe('false');
        expect(screen.getByTestId('bench-scenario-dropdown').textContent).toContain('Alpha +1');

        cleanup();
    }, 10000);
});
