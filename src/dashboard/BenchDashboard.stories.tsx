// dashboard/BenchDashboard.stories.tsx — Storybook stories for the dashboard.
//
// Three canonical states, each wired to realistic fixture data:
//   Overview — 3 models benchmarked, 1 model with a failed iteration
//   Running  — one bench in flight, live feed lines
//   Empty    — pristine idle state (everything em-dashes / placeholders)
//
// These stories double as the interaction tests via @library/test's
// storybookTestRunner (see BenchDashboard.test.tsx), so the `play` functions
// below are the executable spec.
import { Meta } from '@storybook/react';
import { asStory, configureStoryControls } from '@library/test';
import React from 'react';
import { BenchDashboard } from './BenchDashboard';
import { sampleReports, samplePrompt, sampleLogs, runningLogs, sampleEntries, runningEntry } from './sample';

// Full-frame presentation so the dashboard canvas is exactly what the UI looks
// like in production (100vh, no storybook canvas letterboxing).
const frameStyle: React.CSSProperties = {
    height: '100vh',
    width: '100%',
    overflow: 'hidden',
    margin: 0
};

// ── Meta / Config ──────────────────────────────────────────────────────────
const meta: Meta = {
    title: 'Agentic/Bench/Dashboard',
    // Full dashboard is the shared component; stories inject data via args.
    component: BenchDashboard,
    decorators: (story) => {
        // Each story renders inside a full-frame wrapper
        return (
            <div style={frameStyle}>{story()}</div>
        );
    }
};

export default meta;

// Expose the display props as Storybook controls
configureStoryControls(meta, {
    status: 'done'
});

// ── Stories ────────────────────────────────────────────────────────────────

// The money shot: three benchmarked models, the active model's panel with
// its run controls + settled and in-flight benchmark entries.
export const Overview = asStory({
    args: {
        reports: sampleReports,
        entries: sampleEntries,
        logs: sampleLogs,
        status: 'done',
        prompt: samplePrompt
    },
    play: async () => {
        // The dashboard renders all fixtures without error — reaching the end
        // of play is the pass condition for the interaction test.
    }
});

// A benchmark currently in flight: one entry running (progress strip +
// partial rows), live console lines.
export const Running = asStory({
    args: {
        reports: sampleReports.slice(1, 2), // one model already finished
        entries: [runningEntry],
        logs: runningLogs,
        status: 'running',
        prompt: samplePrompt
    },
    play: async () => {
        // Interaction: nothing required — state renders as injected.
    }
});

// Pristine first launch: everything collapses to the quiet empty state.
export const Empty = asStory({
    args: {
        reports: [],
        logs: [],
        status: 'idle'
    },
    play: async () => {
        // Interaction: nothing required — the empty state must render.
    }
});