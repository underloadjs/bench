// dashboard/components/modules/SectionHeader.tsx — the top app bar.
//
// Layout: [ brand mark ] [ Bench / MODEL BENCHMARKS ] ─── [ theme control ] [ status pill ]
//
// The status pill reflects the dashboard-wide lifecycle from the context store
// (idle → grey, running → amber pulsing dot, done → green). NOTE: the New
// Run trigger was RELOCATED into the RunBar (components/modules/RunBar.tsx)
// so it sits directly next to the benchmark scenario dropdown it dispatches.
import React from 'react';
import { styledComponent } from '@presource/react';
import { benchTheme, useBenchThemeMode, setBenchThemeMode, type BenchThemeMode } from '../../utilities';
import { benchDashboardStore, type BenchDashboardStatus } from '../../context';

// Tone mapping per lifecycle state: idle = grey, running = amber, done = green
const STATUS_TONES: Record<BenchDashboardStatus, { dot: string; ink: string; soft: string }> = {
    idle: { dot: benchTheme.textMuted, ink: benchTheme.textSecondary, soft: benchTheme.surfaceFaint },
    running: { dot: benchTheme.warning, ink: benchTheme.warning, soft: benchTheme.warningSoft },
    done: { dot: benchTheme.success, ink: benchTheme.success, soft: benchTheme.successSoft }
};

// The 64px-tall white bar the whole dashboard hangs from
const HeaderBar = styledComponent('header', {
    height: 64,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 24px',
    background: benchTheme.surface,
    borderBottom: `1px solid ${benchTheme.border}`,
    position: 'relative',
    zIndex: 10
});

// Indigo tile with the "B" monogram — the product's visual anchor
const BrandMark = styledComponent('div', {
    width: 30,
    height: 30,
    borderRadius: 9,
    background: benchTheme.accent,
    color: benchTheme.onAccent,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: benchTheme.sansFont,
    flexShrink: 0
});

// "Bench" product name
const BrandTitle = styledComponent('span', {
    fontSize: 16,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: benchTheme.textPrimary,
    fontFamily: benchTheme.sansFont
});

// Uppercase category tag right of the title
const BrandTag = styledComponent('span', {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.1em',
    color: benchTheme.textMuted,
    textTransform: 'uppercase'
});

// Left cluster groups mark + title + tag
const BrandCluster = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
});

// Title + tag stacked vertically (name above the category tag)
const BrandTextColumn = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 1
});

// The status pill: tinted rounded chip with a colored dot + uppercase label
const StatusPill = styledComponent<{ toneSoft: string; toneInk: string }>('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    borderRadius: 999,
    // tint follows the lifecycle state
    background: ({ toneSoft }) => toneSoft
});

// The 8px lifecycle indicator dot inside the status pill
const StatusDot = styledComponent<{ toneDot: string }>('span', {
    width: 8,
    height: 8,
    borderRadius: 999,
    display: 'inline-block',
    // dot colour follows the lifecycle state
    background: ({ toneDot }) => toneDot
});

// Uppercase pill label (IDLE / RUNNING / DONE)
const StatusLabel = styledComponent<{ toneInk: string }>('span', {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: ({ toneInk }) => toneInk,
    fontFamily: benchTheme.sansFont
});

// ── Theme mode control (system / light / dark segmented buttons) ────────────

// One label per mode; SYSTEM resolves against the OS preference
const THEME_MODE_LABELS: Array<{ mode: BenchThemeMode; label: string; title: string }> = [
    { mode: 'system', label: 'System', title: 'Follow the OS color scheme' },
    { mode: 'light', label: 'Light', title: 'Force the light palette' },
    { mode: 'dark', label: 'Dark', title: 'Force the dark palette' }
];

// Grouped border container around the three mode buttons
const ThemeControlGroup = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    border: `1px solid ${benchTheme.border}`,
    borderRadius: 8,
    overflow: 'hidden'
});

// One mode button. `active` tints the selected segment (passed as a string
// so nothing leaks into the DOM — RailButton pattern in framework/host.tsx).
const ThemeModeButton = styledComponent<{ active: string }>('button', {
    background: ({ active }) => (active === 'true' ? benchTheme.accentSoft : 'transparent'),
    color: ({ active }) => (active === 'true' ? benchTheme.accentInk : benchTheme.textMuted),
    border: 'none',
    padding: '6px 10px',
    fontSize: 11,
    fontWeight: ({ active }) => (active === 'true' ? 700 : 500),
    fontFamily: benchTheme.sansFont,
    cursor: 'pointer',
    transition: 'background 0.15s ease, color 0.15s ease'
});

// Right cluster: theme control + status pill
const HeaderActions = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16
});

/** Top app bar: brand identity on the left, lifecycle status + theme on the right.
 *
 * The run trigger lives in the RunBar next to the scenario dropdown (see
 * components/modules/RunBar.tsx) — this header is display-only.
 */
export const SectionHeader = React.memo(() => {
    // Live dashboard state (status) comes from the shared store
    const bench = benchDashboardStore();
    const { status } = bench;

    // Resolve the tone triple for the pill/dot/label from the status value
    const tone = STATUS_TONES[status] ?? STATUS_TONES.idle;

    // Theme mode: subscribing signal read ('system' | 'light' | 'dark');
    // writes go through setBenchThemeMode → global signal → all subscribers
    // re-render, and useBenchThemeSync re-applies the palette.
    const themeMode = useBenchThemeMode();

    return (
        <HeaderBar>
            <BrandCluster>
                <BrandMark>
                    {'B'}
                </BrandMark>
                <BrandTextColumn>
                    <BrandTitle>
                        {'Bench'}
                    </BrandTitle>
                    <BrandTag>
                        {'Model Benchmark'}
                    </BrandTag>
                </BrandTextColumn>
            </BrandCluster>

            <HeaderActions>
                {/* Theme mode control — 'system' (default) follows the OS */}
                <ThemeControlGroup role="group" aria-label="Color theme">
                    {THEME_MODE_LABELS.map(({ mode, label, title }) => {
                        const active = themeMode === mode;
                        return (
                            <ThemeModeButton
                                key={mode}
                                active={active ? 'true' : 'false'}
                                aria-pressed={active}
                                title={title}
                                data-testid={`theme-mode-${mode}`}
                                onClick={() => setBenchThemeMode(mode)}
                            >
                                {label}
                            </ThemeModeButton>
                        );
                    })}
                </ThemeControlGroup>

                {/* Lifecycle indicator — re-renders automatically on store.status writes */}
                <StatusPill toneSoft={tone.soft} toneInk={tone.ink}>
                    <StatusDot toneDot={tone.dot} />
                    <StatusLabel toneInk={tone.ink}>{status.toUpperCase()}</StatusLabel>
                </StatusPill>
            </HeaderActions>
        </HeaderBar>
    );
});