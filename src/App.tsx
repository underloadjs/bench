// src/App.tsx — dev shell for the @agentic/bench dashboard.
//
// THE FLEET IS LOADED FROM A USER-SUPPLIED OPENAI-COMPATIBLE ENDPOINT: the
// operator enters a base URL (e.g. http://192.168.50.109:5500/providers/private/v1
// — the pre-filled default) in an input dialog. On load the app asks that
// endpoint's OpenAI-compatible catalog (GET {base}/models — core/provider.ts
// fetchProviderModels) which models exist. Every catalog entry becomes a
// BENCH PLUGIN (dashboard/plugins/index.ts catalogToPluginFactories, bound to
// the SAME base URL so completions hit the provider the models came from),
// and those plugins feed the dashboard's plugin framework — the dashboard
// itself is a plugin host (dashboard/framework) that loads plugin factories
// one by one, renders the active plugin's panel and executes the active
// plugin's run action on "New Run".
//
// RESOLUTION STATES:
//   1. Dialog — no catalog loaded yet. Input pre-filled with
//      DEFAULT_PROVIDER_URL; "Load Models" runs the GET.
//   2. "Resolving provider catalog…" splash while the GET is in flight.
//   3. Catalog resolved → the REAL fleet mounts (one plugin per model id).
//   4. Fetch failed / empty → the dialog stays up with the error message;
//      fix the URL or start the provider and try again.
//
// Resolving the fleet exactly once per load keeps the pluginFactories prop
// IDENTITY-STABLE across the dashboard's lifetime — the plugin loader builds
// its rail incrementally and must never see the list swapped mid-session.
// It also protects the shared store: the provider re-merges its `data` prop
// on every re-render (localContextStore semantics), so a caller re-render
// would otherwise clobber in-dash state (status/logs/selection).
import React, { useEffect } from 'react';
import { useStateHook } from '@presource/react';
import { fetchProviderModels, DEFAULT_PROVIDER_URL } from './index';
import { BenchDashboard, type BenchDashboardStatus } from './index';
import { type BenchPluginFactory, catalogToPluginFactories, PLUGINS, BENCH_PROMPT } from './index';
import { styledComponent } from '@presource/react';
import { benchTheme, useBenchThemeSync } from './index';

// Pre-filled provider base URL: the LAN provider service origin + the
// /providers/private/v1 route prefix (runtime/endpoint/provider/private/
// constant.ts BASE_URL). ANY OpenAI-compatible v1/models base URL works —
// the operator can replace it in the dialog.
const DEFAULT_BASE_URL = DEFAULT_PROVIDER_URL;

/**
 * Dev shell: loads the model fleet from a user-supplied provider endpoint,
 * then renders the plugin dashboard.
 */
export const App = () => {
    // THEME SYNC: applies the palette (default mode 'system' — follows the
    // OS prefers-color-scheme, live) for BOTH the dialog and the dashboard.
    // BenchDashboardBody calls it too; double application is idempotent.
    useBenchThemeSync();

    // The resolved fleet (null = no catalog loaded yet → dialog shows).
    const fleet = useStateHook<BenchPluginFactory[] | null>(null);
    // The text currently in the dialog's input (pre-filled with the default).
    const urlDraft = useStateHook(DEFAULT_BASE_URL);
    // Error message from the last load attempt (rendered under the input).
    const loadError = useStateHook('');
    // True while a catalog GET is in flight (input + button disabled).
    const resolving = useStateHook(false);

    // LOAD the fleet from the entered base URL: GET {base}/models → catalog
    // entries → plugin factories bound to that base URL. On failure or an
    // empty catalog the dialog stays up with the error shown — the operator
    // can correct the URL and retry. The fleet resolves EXACTLY ONCE per
    // load: setFleet is called a single time per successful load, so the
    // dashboard mounts against a stable plugin list.
    const loadCatalog = async () => {
        const baseUrl = urlDraft().trim();
        if (baseUrl.length === 0 || resolving()) return;

        resolving(true);
        loadError('');
        try {
            const list = await fetchProviderModels(baseUrl);
            if (Array.isArray(list) && list.length > 0) {
                // Bind every model plugin to the SAME endpoint the catalog
                // came from so chat/completions hits the right provider.
                fleet(catalogToPluginFactories(list, baseUrl));
            } else {
                loadError('The provider returned no models — check the URL and try again.');
            }
        } catch (reason: unknown) {
            // Unreachable provider / non-OpenAI response → surface the error
            // in the dialog; the dashboard stays down until a load succeeds.
            loadError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            resolving(false);
        }
    };

    // The dashboard mounts ONLY against a resolved fleet — the plugin
    // framework is display-only; the fleet config (prompt/iterations/
    // concurrency/baseUrl) is baked into each factory by
    // catalogToPluginFactories.
    if (fleet()) {
        return (
            <BenchDashboard
                reports={[]}
                logs={[]}
                status={'idle' as BenchDashboardStatus}
                prompt={BENCH_PROMPT}
                pluginFactories={fleet()!}
            />
        );
    }

    // Splash while the catalog GET is in flight (sub-second on the LAN)
    if (resolving()) {
        return (
            <ResolveShell>
                <ResolveCard>
                    <ResolveTitle>{'Bench'}</ResolveTitle>
                    <ResolveHint>{`Resolving provider catalog at ${urlDraft().trim()} …`}</ResolveHint>
                </ResolveCard>
            </ResolveShell>
        );
    }

    // ── Provider dialog: no fleet loaded yet ──────────────────────────────────
    // The operator enters any OpenAI-compatible base URL; "Load Models"
    // triggers the catalog GET that mounts the dashboard.
    return (
        <ResolveShell>
            <ResolveCard>
                <ResolveTitle>{'Bench'}</ResolveTitle>
                <ResolveHint>{'Enter an OpenAI-compatible provider base URL (v1) to load the model fleet.'}</ResolveHint>
                <UrlInput
                    data-testid="provider-url-input"
                    type="text"
                    value={urlDraft()}
                    placeholder={DEFAULT_BASE_URL}
                    aria-label="Provider base URL"
                    spellCheck={false}
                    // Enter in the input = Load Models (standard dialog flow)
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => urlDraft(event.target.value)}
                    onKeyDown={(event: React.KeyboardEvent) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            void loadCatalog();
                        }
                    }}
                />
                <LoadButton data-testid="load-models" onClick={() => void loadCatalog()}>
                    {'Load Models'}
                </LoadButton>
                {loadError() ? <ErrorText data-testid="provider-error">{loadError()}</ErrorText> : null}
            </ResolveCard>
        </ResolveShell>
    );
};

// ── Catalog dialog + splash (styled to match the dashboard shell) ────────────

const ResolveShell = styledComponent('div', {
    height: '100vh',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: benchTheme.background,
    color: benchTheme.textPrimary,
    fontFamily: benchTheme.sansFont
});

const ResolveCard = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: '32px 40px',
    background: benchTheme.surface,
    border: `1px solid ${benchTheme.border}`,
    borderRadius: benchTheme.radius,
    boxShadow: benchTheme.shadow,
    maxWidth: 520
});

const ResolveTitle = styledComponent('span', {
    fontSize: 16,
    fontWeight: 700,
    color: benchTheme.textPrimary
});

const ResolveHint = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.textMuted,
    textAlign: 'center'
});

// styledComponent's typed surface is HTMLAttributes<HTMLElement> (no
// value/onChange input props), so cast to the InputHTMLAttributes surface
// (maths worksheet-kit PageInput pattern, worksheet-kit.tsx:411-430).
const UrlInput = styledComponent('input', {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    border: `1px solid ${benchTheme.border}`,
    borderRadius: 10,
    fontSize: 13,
    fontFamily: benchTheme.monoFont,
    color: benchTheme.textPrimary,
    background: benchTheme.surfaceFaint,
    outline: 'none'
}) as unknown as React.ForwardRefExoticComponent<
    React.InputHTMLAttributes<HTMLInputElement> & { theme?: any; [breakpoint: string]: any }
>;

// Primary action button — same visual language as the header's New Run
const LoadButton = styledComponent('button', {
    background: benchTheme.accent,
    color: '#ffffff',
    border: 'none',
    borderRadius: 8,
    padding: '10px 20px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: benchTheme.sansFont,
    cursor: 'pointer'
});

// Fetch-failure message from the last load attempt
const ErrorText = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.danger,
    fontFamily: benchTheme.monoFont,
    textAlign: 'center',
    overflowWrap: 'anywhere'
});
