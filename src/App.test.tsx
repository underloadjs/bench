// src/App.test.tsx — dialog + interaction test for the dev App shell.
//
// Renders the full dev App (provider dialog + plugin-framework dashboard
// wiring) under jsdom with @testing-library/react. The app no longer
// resolves a fleet automatically: it shows a provider-URL dialog (pre-filled
// with DEFAULT_PROVIDER_URL) and only mounts the dashboard after the
// operator loads ANY OpenAI-compatible v1/models catalog. globalThis.fetch
// is stubbed so both failure and success paths are deterministic:
//
//   1. Dialog initial state (input pre-filled, Load Models present).
//   2. Failed load (HTTP 500 with an error body) → the dialog stays up with
//      the provider's error message surfaced.
//   3. Successful load (catalog with 2 models) → the dashboard mounts and
//      every model lands in the rail (loader adds them one by one).
//   4. "New Run" executes the default-selected FIRST model against the SAME
//      base URL — the stub answers the streaming chat/completions POST, the
//      run completes, and the status pill settles on DONE with real stats.
import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { DEFAULT_PROVIDER_URL, BENCH_PROMPT, BENCH_ITERATIONS, catalogToPluginFactories } from './index';

// The dialog/header brand title is the VERSIONED product name —
// "Bench v<version>" (PRODUCT_TITLE in src/version.ts, version read from
// this package's package.json). Derive the expected value from the real
// package.json — the same single source vite.config.ts and vitest.config.ts
// inject as the `__APP_VERSION__` define — so the assertion cannot drift
// from the value the shipped bundle renders. `npm test` always runs vitest
// from the package root (vitest.config.ts is resolved from that cwd), so
// 'package.json' is cwd-relative; the jsdom test environment rewrites
// import.meta.url, so a URL-based path would be a non-file scheme (same
// convention as distribution/chat-assistant's ChatAssistantApp test).
const EXPECTED_PRODUCT_TITLE = `Bench v${JSON.parse(
    readFileSync('package.json', 'utf-8')
).version as string}`;

// ── Fetch stub plumbing ──────────────────────────────────────────────────────

// A minimal OpenAI-compatible catalog the stub serves from GET {base}/models.
// Includes an org-prefixed id to cover the rail's "name (org)" label form
// and the stripped-name sort order (kimi-k3 sorts before mock-alpha by name).
const STUB_CATALOG = {
    object: 'list',
    data: [{ id: 'mock-beta' }, { id: 'modal/kimi-k3' }, { id: 'mock-alpha' }]
};

// One SSE frame set: a streamed completion with a usage trailer
const SSE_FRAMES = [
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
    'data: [DONE]\n\n'
].join('');

// Builds a Response whose body streams the SSE frames through a ReadableStream
const sseResponse = (): Response =>
    new Response(
        new ReadableStream({
            start: (controller) => {
                controller.enqueue(new TextEncoder().encode(SSE_FRAMES));
                controller.close();
            }
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );

// Installs the stub: /models → catalog, /chat/completions → SSE stream.
// Returns the mock so tests can assert the exact URLs that were requested.
const stubFetch = () => {
    const mock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/models')) {
            return new Response(JSON.stringify(STUB_CATALOG), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.endsWith('/chat/completions')) {
            return sseResponse();
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    return mock;
};

// Installs a stub that fails every /models request the way the real
// provider does on an outage (error body → the client's error message).
const stubFailingFetch = () => {
    const mock = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'provider registry unavailable' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        })
    );
    globalThis.fetch = mock as unknown as typeof fetch;
    return mock;
};

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // Drop the stub so the next test installs a fresh one
    delete (globalThis as { fetch?: unknown }).fetch;
});

// The dialog's Load Models trigger
const loadButton = () => screen.getByTestId('load-models') as HTMLButtonElement;
const urlInput = () => screen.getByTestId('provider-url-input') as HTMLInputElement;

// Retypes the dialog's input to the given URL (fireEvent.change drives
// React's controlled-input onChange — a raw 'input' Event does not)
const setUrl = async (value: string) => {
    await act(async () => {
        fireEvent.change(urlInput(), { target: { value } });
    });
};

describe('App (dev shell)', () => {
    it('starts on the provider dialog with the default URL pre-filled', async () => {
        stubFetch();

        render(<App />);

        // Dialog chrome — the brand title carries the package version
        expect(screen.getByText(EXPECTED_PRODUCT_TITLE)).toBeTruthy();
        expect(screen.getByText(/Enter an OpenAI-compatible provider base URL/)).toBeTruthy();
        // Input pre-filled with the LAN provider default (any v1 base works)
        expect(urlInput().value).toBe(DEFAULT_PROVIDER_URL);
        expect(screen.getByLabelText('Provider base URL')).toBeTruthy();
        expect(loadButton()).toBeTruthy();
        // The dashboard must NOT be mounted yet
        expect(screen.queryByText('Model Benchmark')).toBeNull();

        cleanup();
    }, 10000);

    it('surfaces the provider error and stays on the dialog when the load fails', async () => {
        stubFailingFetch();

        render(<App />);

        await act(async () => {
            loadButton().click();
        });

        // The client surfaces the body's error string verbatim when present
        // (the "(HTTP 500)" suffix only applies to non-JSON error bodies)
        await waitFor(() => {
            expect(screen.getByTestId('provider-error').textContent).toBe('provider registry unavailable');
        });

        // The dialog is still up — the dashboard never mounted
        expect(urlInput()).toBeTruthy();
        expect(screen.queryByText('Model Benchmark')).toBeNull();

        cleanup();
    }, 10000);

    it('loads any OpenAI-compatible catalog and mounts the dashboard with one rail entry per model', async () => {
        const mock = stubFetch();

        render(<App />);

        // Swap in a custom OpenAI-compatible base URL (NOT the LAN default)
        await setUrl('http://mock.local/v1');
        await act(async () => {
            loadButton().click();
        });

        // The catalog GET hit the exact user-supplied endpoint
        expect(mock.mock.calls.some(([input]) => String(input) === 'http://mock.local/v1/models')).toBe(true);

        // Dashboard chrome replaces the dialog
        await waitFor(() => {
            expect(screen.getByText('Model Benchmark')).toBeTruthy();
        });
        expect(screen.queryByTestId('load-models')).toBeNull();
        expect(screen.getByText('IDLE')).toBeTruthy();
        expect(screen.getByLabelText('Start a new benchmark run')).toBeTruthy();

        // Every catalog entry lands in the rail (loader adds one by one) —
        // org-prefixed ids display the shortened "name (org)" form
        await waitFor(() => {
            expect(screen.getByLabelText('Benchmark kimi-k3 (modal)')).toBeTruthy();
        });
        await waitFor(() => {
            expect(screen.getByLabelText('Benchmark mock-alpha')).toBeTruthy();
        });
        await waitFor(() => {
            expect(screen.getByLabelText('Benchmark mock-beta')).toBeTruthy();
        });

        // RAIL ORDER: sorted by the STRIPPED model name (kimi-k3 < mock-alpha
        // < mock-beta), not by the raw catalog id order (mock-beta was first)
        const railLabels = Array.from(document.querySelectorAll('button[aria-label^="Benchmark "]')).map(
            (button) => button.getAttribute('aria-label')
        );
        expect(railLabels).toEqual(['Benchmark kimi-k3 (modal)', 'Benchmark mock-alpha', 'Benchmark mock-beta']);

        // The run-timeline / console right column was removed from the layout
        expect(screen.queryByText('Run Timeline')).toBeNull();
        expect(screen.queryByText('Console')).toBeNull();

        cleanup();
    }, 10000);

    it('New Run executes the default-selected first model and settles on DONE', async () => {
        // Sanity: the fleet config the App bakes into each plugin
        expect(BENCH_ITERATIONS).toBe(3);
        expect(typeof BENCH_PROMPT).toBe('string');

        const mock = stubFetch();
        render(<App />);

        // Load the fleet from the stub provider
        await setUrl('http://mock.local/v1');
        await act(async () => {
            loadButton().click();
        });
        await waitFor(() => {
            expect(screen.getByText('Model Benchmark')).toBeTruthy();
        });

        // Run the default-selected FIRST model (the registry's default-once
        // fallback selects it on a fresh dashboard)
        await act(async () => {
            screen.getByLabelText('Start a new benchmark run').click();
        });

        // The run action POSTs streaming completions to the SAME base URL
        await waitFor(
            () => {
                expect(mock.mock.calls.some(([input]) => String(input) === 'http://mock.local/v1/chat/completions')).toBe(true);
            },
            { timeout: 5000 }
        );

        // The run executes near-instantly against the in-memory stub, so
        // the transient RUNNING pill is not reliably observable — assert the
        // settled state: DONE with the new benchmark entry fully populated
        // (3 iterations, all successful → "3/3 runs" in the entry header).
        await waitFor(
            () => {
                // Header pill + the entry's status chip both read DONE
                expect(screen.getAllByText('DONE').length).toBeGreaterThan(0);
            },
            { timeout: 10000 }
        );
        // The panel created ONE benchmark entry (default scenario ticked)
        expect(screen.getByText('3/3 runs')).toBeTruthy();
        // The scenario label shows in the dropdown trigger AND the entry
        expect(screen.getAllByText('Short Story').length).toBeGreaterThan(0);
        // The panel title names the benchmarked model's DISPLAY label —
        // the sorted fleet's first entry is the org-prefixed id
        // modal/kimi-k3, shown as "kimi-k3 (modal)" (multiple matches —
        // rail / panel title all show it — so assert ≥1)
        expect(screen.getAllByText('kimi-k3 (modal)').length).toBeGreaterThan(0);

        cleanup();
    }, 20000);

    it('rail clicks toggle model columns (multi-select: several columns at once)', async () => {
        stubFetch();
        render(<App />);

        // Load the fleet from the stub provider
        await setUrl('http://mock.local/v1');
        await act(async () => {
            loadButton().click();
        });
        await waitFor(() => {
            expect(screen.getByText('Model Benchmark')).toBeTruthy();
        });

        // Default selection: the FIRST rail model renders as the single
        // column (registry's default-once fallback)
        const columnTitles = () =>
            screen.getAllByTestId('bench-toolbar-model').map((node) => node.textContent);
        await waitFor(() => {
            expect(columnTitles()).toEqual(['kimi-k3 (modal)']);
        });

        // Tick a second model — its column appears BESIDE the first
        await act(async () => {
            screen.getByLabelText('Benchmark mock-alpha').click();
        });
        await waitFor(() => {
            expect(columnTitles()).toEqual(['kimi-k3 (modal)', 'mock-alpha']);
        });

        // Tick a third — three columns side by side
        await act(async () => {
            screen.getByLabelText('Benchmark mock-beta').click();
        });
        await waitFor(() => {
            expect(columnTitles()).toEqual(['kimi-k3 (modal)', 'mock-alpha', 'mock-beta']);
        });

        // Untick mock-alpha — its column disappears (multi-select, not the
        // old single-activation swap)
        await act(async () => {
            screen.getByLabelText('Benchmark mock-alpha').click();
        });
        await waitFor(() => {
            expect(columnTitles()).toEqual(['kimi-k3 (modal)', 'mock-beta']);
        });

        cleanup();
    }, 10000);

    it('New Run benches EVERY selected model in one go (one entry per model)', async () => {
        // THE UPGRADE CONTRACT: execution is separated from the models — one
        // New Run click dispatches the ticked scenario against EVERY
        // selected model (a column each) simultaneously.
        const completions: Array<{ url: string; body: { model?: string } | null }> = [];
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/models')) {
                return new Response(JSON.stringify(STUB_CATALOG), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.endsWith('/chat/completions')) {
                completions.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
                return sseResponse();
            }
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        render(<App />);

        await setUrl('http://mock.local/v1');
        await act(async () => {
            loadButton().click();
        });
        await waitFor(() => {
            expect(screen.getByText('Model Benchmark')).toBeTruthy();
        });

        // Tick TWO models (default first + mock-alpha), then run ONCE
        await act(async () => {
            screen.getByLabelText('Benchmark mock-alpha').click();
        });
        await waitFor(() => {
            expect(screen.getAllByTestId('bench-toolbar-model').length).toBe(2);
        });
        await act(async () => {
            screen.getByLabelText('Start a new benchmark run').click();
        });

        // BOTH models were executed against the loaded provider
        await waitFor(
            () => {
                const models = completions.map((call) => call.body?.model);
                expect(models).toContain('modal/kimi-k3');
                expect(models).toContain('mock-alpha');
            },
            { timeout: 5000 }
        );

        // One settled entry per selected model, each with the full plan
        await waitFor(
            () => {
                const entries = Array.from(document.querySelectorAll('[data-testid^="bench-entry-"]'));
                expect(entries.length).toBe(2);
                entries.forEach((entry) => {
                    expect(entry.textContent).toContain('3/3 runs');
                    expect(entry.textContent).toContain('DONE');
                });
            },
            { timeout: 10000 }
        );

        cleanup();
    }, 20000);

    it('column target fields autofill per model, and edits reroute that column outside the catalog', async () => {
        // THE PER-COLUMN TARGETS: each model column carries the two editable
        // fields (model + endpoint) its runs execute against — autofilled
        // from the model's own binding, editable to benchmark models/
        // endpoints OUTSIDE the loaded catalog. This test pins: activation
        // autofill per column → manual edit → New Run posts BOTH the
        // untouched column's own binding AND the edited column's custom
        // target.
        const completions: Array<{ url: string; body: { model?: string } | null }> = [];
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/models')) {
                return new Response(JSON.stringify(STUB_CATALOG), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.endsWith('/chat/completions')) {
                completions.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
                return sseResponse();
            }
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        render(<App />);

        await setUrl('http://mock.local/v1');
        await act(async () => {
            loadButton().click();
        });
        await waitFor(() => {
            expect(screen.getByText('Model Benchmark')).toBeTruthy();
        });

        // Column-scoped field helpers: each column carries its OWN pair of
        // target fields
        const columnFor = (title: string): HTMLElement => {
            const found = Array.from(document.querySelectorAll('[data-testid^="bench-column-"]')).find(
                (column) => column.querySelector('[data-testid="bench-toolbar-model"]')?.textContent === title
            );
            if (!found) throw new Error(`column not found: ${title}`);
            return found as HTMLElement;
        };
        const fieldIn = (column: HTMLElement, testId: string) =>
            column.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;

        // ACTIVATION AUTOFILL: the default column (modal/kimi-k3) shows its
        // own binding in both fields
        const kimiColumn = columnFor('kimi-k3 (modal)');
        await waitFor(() => {
            expect(fieldIn(kimiColumn, 'bench-target-model').value).toBe('modal/kimi-k3');
        });
        expect(fieldIn(kimiColumn, 'bench-target-endpoint').value).toBe('http://mock.local/v1');

        // Tick mock-alpha — its column autofills ITS binding
        await act(async () => {
            screen.getByLabelText('Benchmark mock-alpha').click();
        });
        const alphaColumn = await waitFor(() => {
            const column = columnFor('mock-alpha');
            expect(fieldIn(column, 'bench-target-model').value).toBe('mock-alpha');
            return column;
        });
        expect(fieldIn(alphaColumn, 'bench-target-endpoint').value).toBe('http://mock.local/v1');

        // EDIT: retarget mock-alpha's column OUTSIDE the loaded catalog
        await act(async () => {
            fireEvent.change(fieldIn(alphaColumn, 'bench-target-model'), { target: { value: 'custom-model' } });
        });
        await act(async () => {
            fireEvent.change(fieldIn(alphaColumn, 'bench-target-endpoint'), { target: { value: 'http://custom.local/v1' } });
        });
        expect(fieldIn(alphaColumn, 'bench-target-model').value).toBe('custom-model');
        expect(fieldIn(alphaColumn, 'bench-target-endpoint').value).toBe('http://custom.local/v1');

        // THE RUN follows BOTH columns: the untouched kimi-k3 column posts
        // its own binding; the edited column posts to the CUSTOM endpoint
        // with the CUSTOM model id as the routing key
        await act(async () => {
            screen.getByLabelText('Start a new benchmark run').click();
        });
        await waitFor(
            () => {
                const edited = completions.find(
                    (call) => call.url === 'http://custom.local/v1/chat/completions' && call.body?.model === 'custom-model'
                );
                const own = completions.find(
                    (call) => call.url === 'http://mock.local/v1/chat/completions' && call.body?.model === 'modal/kimi-k3'
                );
                expect(edited).toBeTruthy();
                expect(own).toBeTruthy();
            },
            { timeout: 5000 }
        );

        cleanup();
    }, 20000);

    it('theme control: dark/light force the palette, system follows the OS preference', async () => {
        stubFetch();
        render(<App />);

        // Load the fleet to mount the dashboard (the header hosts the control)
        await setUrl('http://mock.local/v1');
        await act(async () => {
            loadButton().click();
        });
        await waitFor(() => {
            expect(screen.getByText('Model Benchmark')).toBeTruthy();
        });

        const root = document.documentElement;

        // DEFAULT = SYSTEM: jsdom has no matchMedia → the light palette is applied
        expect(root.getAttribute('data-bench-theme')).toBe('light');
        expect(root.style.getPropertyValue('--bench-background')).toBe('#f5f6f8');
        // The System segment is the active one
        expect(screen.getByTestId('theme-mode-system').getAttribute('aria-pressed')).toBe('true');

        // Click DARK → the root vars flip to the dark palette
        await act(async () => {
            screen.getByTestId('theme-mode-dark').click();
        });
        expect(root.getAttribute('data-bench-theme')).toBe('dark');
        expect(root.style.getPropertyValue('--bench-background')).toBe('#0f1115');
        expect(root.style.getPropertyValue('--bench-surface')).toBe('#171a21');
        expect(screen.getByTestId('theme-mode-dark').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('theme-mode-system').getAttribute('aria-pressed')).toBe('false');

        // Click LIGHT → light palette returns
        await act(async () => {
            screen.getByTestId('theme-mode-light').click();
        });
        expect(root.getAttribute('data-bench-theme')).toBe('light');
        expect(root.style.getPropertyValue('--bench-background')).toBe('#f5f6f8');

        // Click SYSTEM with a STUBBED matchMedia reporting OS=dark → the
        // palette resolves to dark. Then a live OS flip (dark → light) is
        // re-applied WITHOUT any click: system mode follows the OS through
        // the change listener the sync effect registered.
        const listeners: Array<(event: { matches: boolean }) => void> = [];
        vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
            matches: query === '(prefers-color-scheme: dark)',
            media: query,
            addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.push(listener),
            removeEventListener: vi.fn()
        })));
        await act(async () => {
            screen.getByTestId('theme-mode-system').click();
        });
        expect(root.getAttribute('data-bench-theme')).toBe('dark');

        // The sync effect registered a change listener on the media query
        expect(listeners.length).toBeGreaterThan(0);

        // OS flips to light → palette follows (no click involved)
        await act(async () => {
            listeners.forEach((listener) => listener({ matches: false }));
        });
        expect(root.getAttribute('data-bench-theme')).toBe('light');
        expect(root.style.getPropertyValue('--bench-background')).toBe('#f5f6f8');

        // OS flips back to dark → dark again
        await act(async () => {
            listeners.forEach((listener) => listener({ matches: true }));
        });
        expect(root.getAttribute('data-bench-theme')).toBe('dark');

        cleanup();
    }, 10000);

    it('catalogToPluginFactories binds the fleet to the catalog base URL', async () => {
        // The factory list is the App's wiring contract: the URL the operator
        // entered MUST ride along so completions hit the same provider.
        const fleet = catalogToPluginFactories([{ id: 'mock-alpha' }], 'http://mock.local/v1');
        expect(fleet.length).toBe(1);
        expect(typeof fleet[0]).toBe('function');
    });

    it('fans concurrency out into PARALLEL bench entries (3 concurrency → 3 benches)', async () => {
        // REGRESSION COVERAGE for the operator report "3 concurrency running,
        // but only 1 shows up": the Concurrency select must fan the run out
        // into that many SEPARATE, VISIBLE bench entries (lanes) generating
        // simultaneously — not squeeze it into one entry. Load-test semantics
        // (k6 vus × iterations): iterations = runs per lane, concurrency =
        // lane count. This test pins the exact reported scenario:
        // iterations 1 + concurrency 3 → THREE benches, three simultaneous
        // completions, each lane settling at "1/1 runs".
        let inFlight = 0;
        let maxInFlight = 0;
        let completions = 0;

        const heldSse = (): Response =>
            new Response(
                new ReadableStream({
                    start: (controller) => {
                        setTimeout(() => {
                            controller.enqueue(new TextEncoder().encode(SSE_FRAMES));
                            controller.close();
                        }, 400);
                    }
                }),
                { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
            );

        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/models')) {
                return new Response(JSON.stringify(STUB_CATALOG), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.endsWith('/chat/completions')) {
                completions += 1;
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                const response = heldSse();
                // Free the slot after the same hold window (do NOT consume
                // the body here — the provider's reader needs it unlocked)
                setTimeout(() => {
                    inFlight -= 1;
                }, 400);
                return response;
            }
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        render(<App />);

        // Load the fleet from the stub provider
        await setUrl('http://mock.local/v1');
        await act(async () => {
            loadButton().click();
        });
        await waitFor(() => {
            expect(screen.getByText('Model Benchmark')).toBeTruthy();
        });

        // Pin the EXACT reported plan: 1 iteration per bench, 3 parallel benches
        await act(async () => {
            fireEvent.change(screen.getByTestId('bench-iterations-input'), { target: { value: '1' } });
        });
        await act(async () => {
            fireEvent.change(screen.getByTestId('bench-concurrency-input'), { target: { value: '3' } });
        });

        // Run the ACTIVE plugin (single default-ticked scenario)
        await act(async () => {
            screen.getByLabelText('Start a new benchmark run').click();
        });

        // THREE bench entries appear (one per lane, lane-tagged captions)…
        await waitFor(
            () => {
                const entries = Array.from(document.querySelectorAll('[data-testid^="bench-entry-"]'));
                expect(entries.length).toBe(3);
            },
            { timeout: 5000 }
        );
        const laneLabels = Array.from(document.querySelectorAll('[data-testid^="bench-entry-"]'))
            .map((entry) => entry.querySelector('span')?.textContent)
            // The store prepends newest-first — DOM order is lane 3 → lane 1
            .sort();
        expect(laneLabels).toEqual(['Short Story · lane 1', 'Short Story · lane 2', 'Short Story · lane 3']);

        // …three completions fire (1 iteration × 3 lanes)…
        await waitFor(
            () => {
                expect(completions).toBe(3);
            },
            { timeout: 5000 }
        );
        // …and OVERLAP: all three lanes generate simultaneously
        expect(maxInFlight).toBe(3);

        // Every lane settles with its single iteration successful
        await waitFor(
            () => {
                const entries = Array.from(document.querySelectorAll('[data-testid^="bench-entry-"]'));
                expect(entries.length).toBe(3);
                // Substring checks: the entry meta appends the decode/wall
                // readout once the report lands, so '1/1 runs' is never a
                // standalone exact-match text node
                entries.forEach((entry) => {
                    expect(entry.textContent).toContain('1/1 runs');
                    expect(entry.textContent).toContain('DONE');
                });
            },
            { timeout: 10000 }
        );

        cleanup();
    }, 30000);
});
