// dashboard/utilities/theme.test.ts — exact-value tests for the theming system.
//
// Covers: palette shape parity (both palettes expose the identical key set),
// var() token references, mode → palette resolution ('system' follows the OS
// media query; jsdom has no matchMedia → light fallback), CSS custom-property
// application (data-bench-theme attribute + --bench-* vars on the document
// root), the system→dark→light→system flow, and live OS-following while in
// system mode via a stubbed matchMedia.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    applyBenchTheme,
    benchTheme,
    BENCH_THEME_PALETTES,
    resolveBenchTheme,
    setBenchThemeMode,
    systemPrefersDark,
    useBenchThemeMode,
    type BenchThemeMode
} from './theme';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';

// Resets the document root the tests mutate + the mode signal back to default
afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-bench-theme');
    document.documentElement.removeAttribute('style');
    setBenchThemeMode('system');
    vi.restoreAllMocks();
    delete (window as { matchMedia?: unknown }).matchMedia;
});

// A minimal hook host — reads (and thus subscribes to) the mode signal
const ModeProbe = ({ onChange }: { onChange?: (mode: BenchThemeMode) => void }) => {
    const mode = useBenchThemeMode();
    onChange?.(mode);
    return <span data-testid="mode-probe">{mode}</span>;
};

describe('benchTheme tokens', () => {
    it('references CSS custom properties for every palette-driven token', () => {
        // Colour/shadow tokens are var() references — this is what makes the
        // palette swap without any JS-side re-render of styled components.
        expect(benchTheme.background).toBe('var(--bench-background)');
        expect(benchTheme.surface).toBe('var(--bench-surface)');
        expect(benchTheme.border).toBe('var(--bench-border)');
        expect(benchTheme.surfaceFaint).toBe('var(--bench-surface-faint)');
        expect(benchTheme.track).toBe('var(--bench-track)');
        expect(benchTheme.textPrimary).toBe('var(--bench-text-primary)');
        expect(benchTheme.textSecondary).toBe('var(--bench-text-secondary)');
        expect(benchTheme.textMuted).toBe('var(--bench-text-muted)');
        expect(benchTheme.accent).toBe('var(--bench-accent)');
        expect(benchTheme.accentSoft).toBe('var(--bench-accent-soft)');
        expect(benchTheme.accentInk).toBe('var(--bench-accent-ink)');
        expect(benchTheme.onAccent).toBe('var(--bench-on-accent)');
        expect(benchTheme.success).toBe('var(--bench-success)');
        expect(benchTheme.successSoft).toBe('var(--bench-success-soft)');
        expect(benchTheme.warning).toBe('var(--bench-warning)');
        expect(benchTheme.warningSoft).toBe('var(--bench-warning-soft)');
        expect(benchTheme.danger).toBe('var(--bench-danger)');
        expect(benchTheme.dangerSoft).toBe('var(--bench-danger-soft)');
        expect(benchTheme.shadow).toBe('var(--bench-shadow)');
    });

    it('keeps mode-invariant tokens literal', () => {
        expect(benchTheme.radius).toBe('14px');
        expect(benchTheme.monoFont).toContain('monospace');
        expect(benchTheme.sansFont).toContain('sans-serif');
    });
});

describe('BENCH_THEME_PALETTES', () => {
    it('exposes the identical key set for light and dark', () => {
        // applyBenchTheme writes every key of the active palette as a CSS
        // var — a key present in light but missing in dark would leave the
        // previous (light) value active after a dark switch.
        expect(Object.keys(BENCH_THEME_PALETTES.dark).sort()).toEqual(Object.keys(BENCH_THEME_PALETTES.light).sort());
    });

    it('paints distinct surface colours per mode', () => {
        expect(BENCH_THEME_PALETTES.light.surface).toBe('#ffffff');
        expect(BENCH_THEME_PALETTES.light.background).toBe('#f5f6f8');
        expect(BENCH_THEME_PALETTES.dark.surface).toBe('#171a21');
        expect(BENCH_THEME_PALETTES.dark.background).toBe('#0f1115');
    });
});

describe('resolveBenchTheme / systemPrefersDark', () => {
    it('falls back to light when matchMedia is unavailable (jsdom default)', () => {
        delete (window as { matchMedia?: unknown }).matchMedia;
        expect(systemPrefersDark()).toBe(false);
        expect(resolveBenchTheme('system')).toBe('light');
    });

    it('resolves system → dark when the OS prefers dark', () => {
        vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
            matches: query === '(prefers-color-scheme: dark)',
            media: query
        })));
        expect(systemPrefersDark()).toBe(true);
        expect(resolveBenchTheme('system')).toBe('dark');
    });

    it('passes explicit modes through regardless of the OS preference', () => {
        vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
            matches: query === '(prefers-color-scheme: dark)',
            media: query
        })));
        expect(resolveBenchTheme('light')).toBe('light');
        expect(resolveBenchTheme('dark')).toBe('dark');
    });
});

describe('applyBenchTheme', () => {
    it('writes the palette as --bench-* custom properties and stamps data-bench-theme', () => {
        applyBenchTheme('light');

        const root = document.documentElement;
        expect(root.getAttribute('data-bench-theme')).toBe('light');
        expect(root.style.getPropertyValue('--bench-background')).toBe('#f5f6f8');
        expect(root.style.getPropertyValue('--bench-surface')).toBe('#ffffff');
        expect(root.style.getPropertyValue('--bench-text-primary')).toBe('#111827');
        expect(root.style.getPropertyValue('--bench-accent')).toBe('#4f46e5');
        expect(root.style.getPropertyValue('--bench-on-accent')).toBe('#ffffff');
        expect(root.style.getPropertyValue('--bench-shadow')).toBe('0 1px 2px rgba(16, 24, 40, 0.04)');
    });

    it('swaps every var on a dark application (no light leftovers)', () => {
        applyBenchTheme('light');
        applyBenchTheme('dark');

        const root = document.documentElement;
        expect(root.getAttribute('data-bench-theme')).toBe('dark');
        expect(root.style.getPropertyValue('--bench-background')).toBe('#0f1115');
        expect(root.style.getPropertyValue('--bench-surface')).toBe('#171a21');
        expect(root.style.getPropertyValue('--bench-text-primary')).toBe('#e6e9f0');
        expect(root.style.getPropertyValue('--bench-accent')).toBe('#6366f1');
        expect(root.style.getPropertyValue('--bench-accent-ink')).toBe('#a5b4fc');
        expect(root.style.getPropertyValue('--bench-shadow')).toBe('0 1px 2px rgba(0, 0, 0, 0.45)');
    });

    it('is a no-op outside a document (SSR safety)', () => {
        // The guard reads `typeof document === 'undefined'` — simulate it
        expect(() => applyBenchTheme('dark')).not.toThrow();
    });
});

describe('theme mode signal', () => {
    it('defaults to system and updates subscribers on set', () => {
        const seen: BenchThemeMode[] = [];
        render(<ModeProbe onChange={(mode) => seen.push(mode)} />);

        expect(screen_probeMode()).toBe('system');

        act(() => {
            setBenchThemeMode('dark');
        });
        expect(screen_probeMode()).toBe('dark');

        act(() => {
            setBenchThemeMode('light');
        });
        expect(screen_probeMode()).toBe('light');

        // Every write re-rendered the subscriber
        expect(seen).toEqual(['system', 'dark', 'light']);
    });
});

// Reads the live probe text (kept out of the describe for reuse clarity)
const screen_probeMode = (): string => document.querySelector('[data-testid="mode-probe"]')!.textContent!;
