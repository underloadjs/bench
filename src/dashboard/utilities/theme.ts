// dashboard/utilities/theme.ts — design tokens + dark/light theming.
//
// DESIGN LANGUAGE: clean, modern, card-based; one indigo accent, monospace
// numerals for metrics, "quiet" elevation.
//
// HOW THEMING WORKS (CSS custom properties, not JS swaps):
//   Every colour/shadow token in `benchTheme` is a `var(--bench-…)`
//   REFERENCE. The concrete values live in the two palettes below
//   (BENCH_THEME_PALETTES) and are written onto document.documentElement as
//   CSS custom properties by applyBenchTheme(). Because var() resolves at
//   paint time, EVERY styledComponent that consumed `benchTheme.x` at module
//   load switches palettes instantly — no re-render, no style rebuild.
//
// MODES: 'system' (default — follows the OS prefers-color-scheme, LIVE), 
// 'light', 'dark'. The mode lives in a global signalState so the header
// control and the sync effect share it without context plumbing. Once the
// user picks light/dark explicitly, the app stops following the OS until
// they switch back to 'system'.

import { useEffect } from 'react';
import { objectEach } from '@presource/core';
import { signalState } from '@presource/react';

// ── Mode types ───────────────────────────────────────────────────────────────

// What the operator picks in the header control
export type BenchThemeMode = 'system' | 'light' | 'dark';

// The concrete palette actually painted (system is resolved against the OS)
export type BenchThemeResolved = 'light' | 'dark';

// ── Concrete palettes ────────────────────────────────────────────────────────
// Both palettes MUST keep identical key sets — applyBenchTheme writes every
// key as a CSS custom property, and the styled components reference them all.

export const BENCH_THEME_PALETTES: Record<BenchThemeResolved, Record<string, string>> = {
    // Light (original design): white cards on a cool off-white page
    light: {
        background: '#f5f6f8',
        surface: '#ffffff',
        border: '#e7e9ef',
        surfaceFaint: '#f9fafb',
        track: '#eef0f4',
        textPrimary: '#111827',
        textSecondary: '#6b7280',
        textMuted: '#9ca3af',
        accent: '#4f46e5',
        accentSoft: '#eef2ff',
        accentInk: '#4338ca',
        success: '#16a34a',
        successSoft: '#ecfdf5',
        warning: '#d97706',
        warningSoft: '#fffbeb',
        danger: '#dc2626',
        dangerSoft: '#fef2f2',
        onAccent: '#ffffff',
        shadow: '0 1px 2px rgba(16, 24, 40, 0.04)'
    },
    // Dark: deep graphite surfaces, lifted cards, brightened accent for
    // contrast on dark. Soft tints become translucent-tinted dark surfaces
    // so pills/strips read as tints instead of glowing blocks.
    dark: {
        background: '#0f1115',
        surface: '#171a21',
        border: '#262b36',
        surfaceFaint: '#1d222c',
        track: '#232834',
        textPrimary: '#e6e9f0',
        textSecondary: '#9aa3b2',
        textMuted: '#657086',
        accent: '#6366f1',
        accentSoft: '#252a4d',
        accentInk: '#a5b4fc',
        success: '#34d399',
        successSoft: '#0e2e22',
        warning: '#fbbf24',
        warningSoft: '#2f2610',
        danger: '#f87171',
        dangerSoft: '#33181a',
        onAccent: '#ffffff',
        shadow: '0 1px 2px rgba(0, 0, 0, 0.45)'
    }
};

// camelCase → kebab-case for the CSS custom-property names
// (surfaceFaint → surface-faint, onAccent → on-accent)
const kebabToken = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// ── The token map consumed by every styled component ─────────────────────────
// Colour/shadow tokens are var() references into the active palette; the
// mode-invariant tokens (fonts, radius) stay literal. SHAPE CONTRACT: the
// keys here are exactly what the dashboard modules have always imported —
// adding onAccent (accent-contrast text) is the only addition.
export const benchTheme = {
    // ── Surfaces ────────────────────────────────────────────────
    background: 'var(--bench-background)',
    surface: 'var(--bench-surface)',
    border: 'var(--bench-border)',
    surfaceFaint: 'var(--bench-surface-faint)',
    track: 'var(--bench-track)',

    // ── Text ────────────────────────────────────────────────────
    textPrimary: 'var(--bench-text-primary)',
    textSecondary: 'var(--bench-text-secondary)',
    textMuted: 'var(--bench-text-muted)',

    // ── Accent / semantic ───────────────────────────────────────
    accent: 'var(--bench-accent)',
    accentSoft: 'var(--bench-accent-soft)',
    accentInk: 'var(--bench-accent-ink)',
    success: 'var(--bench-success)',
    successSoft: 'var(--bench-success-soft)',
    warning: 'var(--bench-warning)',
    warningSoft: 'var(--bench-warning-soft)',
    danger: 'var(--bench-danger)',
    dangerSoft: 'var(--bench-danger-soft)',
    // Text colour that sits ON an accent fill (buttons, brand mark, icon chips)
    onAccent: 'var(--bench-on-accent)',

    // ── Elevation (palette-dependent — dark shadows run deeper) ──
    shadow: 'var(--bench-shadow)',

    // ── Type + shape (mode-invariant) ───────────────────────────
    // Numerals (metrics, tokens, timings) always render monospace so digits
    // align in tables — the core "instrument panel" cue
    monoFont: "'SF Mono', 'Cascadia Code', 'Roboto Mono', Menlo, Consolas, monospace",
    // Everything else
    sansFont: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', 'Helvetica Neue', sans-serif",
    // Standard card corner radius
    radius: '14px'
} as const;

export type BenchTheme = typeof benchTheme;

// ── Mode → palette resolution ────────────────────────────────────────────────

// True when the OS currently prefers dark. jsdom / SSR have no matchMedia →
// light fallback (same convention as the ghost-story distribution App).
export const systemPrefersDark = (): boolean => {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
};

/**
 * Resolves a mode to the concrete palette to paint.
 * 'system' reads the live OS preference; explicit modes pass through.
 */
export const resolveBenchTheme = (mode: BenchThemeMode): BenchThemeResolved => {
    if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
    return mode;
};

/**
 * Writes a resolved palette onto document.documentElement as CSS custom
 * properties (+ a data-bench-theme attribute for tests/debugging). Idempotent
 * and safe to call repeatedly — every var is (re)assigned in one pass.
 */
export const applyBenchTheme = (resolved: BenchThemeResolved): void => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const palette = BENCH_THEME_PALETTES[resolved];
    objectEach(palette, ({ key, value }) => {
        root.style.setProperty(`--bench-${kebabToken(key)}`, value);
    });
    root.setAttribute('data-bench-theme', resolved);
};

// ── Mode signal (global — shared by the header control + sync effect) ────────
// signalState: `benchThemeMode()` subscribes (render-only hook call),
// `setBenchThemeMode(x)` writes and refreshes all subscribers.
const benchThemeModeSignal = signalState<BenchThemeMode>('system');

/** Reads the current theme mode (call inside a component to subscribe). */
export const useBenchThemeMode = (): BenchThemeMode => benchThemeModeSignal();

/** Sets the theme mode ('system' re-enables live OS following). */
export const setBenchThemeMode = (mode: BenchThemeMode): void => {
    benchThemeModeSignal(mode);
};

/**
 * Applies the palette for the current mode and keeps it in sync:
 *   - re-applies whenever the mode changes;
 *   - while mode === 'system', LIVE-follows the OS prefers-color-scheme
 *     (media-query change listener) until an explicit choice is made.
 * Call ONCE per mounted tree (App shell + BenchDashboard body — double
 * mounts are harmless: applying the same vars twice is idempotent).
 */
export const useBenchThemeSync = (): void => {
    // Subscribing read — mode changes re-run the effect below
    const mode = benchThemeModeSignal();

    useEffect(() => {
        applyBenchTheme(resolveBenchTheme(mode));

        // Explicit light/dark: the operator owns the palette; no OS following
        if (mode !== 'system') return;

        // System mode: mirror OS changes until the user overrides
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const query = window.matchMedia('(prefers-color-scheme: dark)');
        const handleChange = (event: MediaQueryListEvent) => {
            applyBenchTheme(event.matches ? 'dark' : 'light');
        };
        // addEventListener is the modern API; older Safari exposes addListener
        query.addEventListener?.('change', handleChange);
        return () => {
            query.removeEventListener?.('change', handleChange);
        };
    }, [mode]);
};

// MODULE-INIT PAINT: apply the initial palette synchronously at import time
// so the very first frame already has every var resolved (no unstyled flash
// before the sync effect runs). NOTE: the raw `.value()` accessor is used —
// calling the signal itself would invoke useState outside a component (an
// invalid hook call at import time); `.value()` reads/writes without hooks.
applyBenchTheme(resolveBenchTheme(benchThemeModeSignal.value()));
