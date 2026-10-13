// dashboard/components/modules/BottomBar.tsx — the status footer.
//
// A 40px white strip pinned under the content area, IDE-style. Left side shows
// the currently configured prompt (truncated). Right side packs the fleet
// roll-up: model count, run completion, longest benchmark wall time, and the
// dashboard status word — the "trust strip" operators glance at.
import React from 'react';
import { styledComponent } from '@presource/react';
import { benchTheme, deriveBenchStats, formatSeconds, truncateText } from '../../utilities';
import { benchDashboardStore } from '../../context';

// The pinned footer bar
const BottomBarShell = styledComponent('footer', {
    height: 40,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 24px',
    background: benchTheme.surface,
    borderTop: `1px solid ${benchTheme.border}`
});

// Left: the active prompt (kept on one line, ellipsised)
const PromptLabel = styledComponent('span', {
    fontSize: 12,
    color: benchTheme.textMuted,
    fontFamily: benchTheme.sansFont,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    maxWidth: '60%'
});

// Prompt caption eyebrow ("PROMPT")
const PromptEyebrow = styledComponent('span', {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: benchTheme.textMuted,
    textTransform: 'uppercase',
    fontFamily: benchTheme.sansFont,
    marginRight: 8,
    flexShrink: 0
});

const PromptCluster = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0
});

// Right: the roll-up chips
const RollUpCluster = styledComponent('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16
});

// One roll-up chip: "3 models" / "18/19 runs" / "wall 34.2s" / "done"
const RollUpItem = styledComponent('span', {
    fontSize: 11.5,
    color: benchTheme.textSecondary,
    fontFamily: benchTheme.monoFont,
    whiteSpace: 'nowrap'
});

// Live chip — accent-tinted so the "something is happening" state pops
// against the neutral roll-up chips (shows how many benchmark entries are
// currently in flight — they run in parallel with each other)
const RunningChip = styledComponent('span', {
    fontSize: 11.5,
    fontWeight: 600,
    color: benchTheme.accentInk,
    background: benchTheme.accentSoft,
    borderRadius: 999,
    padding: '3px 10px',
    fontFamily: benchTheme.monoFont,
    whiteSpace: 'nowrap'
});

/** Status footer: active prompt on the left, fleet roll-up on the right. */
export const BottomBar = React.memo(() => {
    const bench = benchDashboardStore();
    const { reports, prompt, status, entries } = bench;

    // Fleet roll-up figures shared with the stats row (same pure derivation)
    const stats = deriveBenchStats(reports);
    // Longest single benchmark wall time (the fleet's total elapsed lower bound)
    const wallTotal = formatSeconds(stats.maxWallTime);
    // Parallel-entry feedback: how many benchmark entries are in flight
    const runningCount = entries.filter((entry) => entry.status === 'running').length;

    return (
        <BottomBarShell>
            {/* Active prompt — falls back to a hint when nothing is configured */}
            <PromptCluster>
                <PromptEyebrow>{'Prompt'}</PromptEyebrow>
                <PromptLabel title={prompt || undefined}>
                    {truncateText(prompt, 100) || '(no prompt configured)'}
                </PromptLabel>
            </PromptCluster>

            <RollUpCluster>
                {/* LIVE chip while entries are in flight — "2 running" */}
                {runningCount > 0 ? (
                    <RunningChip data-testid="bench-running-chip" role="status">
                        {`${runningCount} running`}
                    </RunningChip>
                ) : null}
                <RollUpItem>{`${stats.modelCount} models`}</RollUpItem>
                <RollUpItem>{`${stats.totalCompleted}/${stats.totalRuns} runs`}</RollUpItem>
                <RollUpItem>{`wall ${wallTotal}`}</RollUpItem>
                {/* status word mirrors the header pill for peripheral vision */}
                <RollUpItem>{status}</RollUpItem>
            </RollUpCluster>
        </BottomBarShell>
    );
});