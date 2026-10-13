// dashboard/components/Card.tsx — the shared card surface.
//
// Every panel in the dashboard (comparison table, timeline, console, stats)
// renders inside this card: white surface, hairline border, 14px radius,
// whisper shadow (tokens from dashboard/utilities/theme.ts).
//
// Structure:
//   <section>            ← CardShell (flex column, overflow hidden)
//     <header>           ← optional; present only when `title` is given
//       <h3> title
//       <span> subtitle + actions row
//       <div> bottom hairline divider
//     <div>              ← CardBody (flex: 1)
//       children
//
// Two body variants exist as distinct components (padded vs flush) instead of
// a boolean prop: styledComponent spreads custom props onto the DOM element,
// and a boolean custom attr would leak `padded="true"` into the markup.
import React from 'react';
import { styledComponent } from '@presource/react';
import { benchTheme } from '../utilities';

// The card frame: white surface + hairline + soft shadow.
// overflow:'hidden' lets full-bleed table rows clip to the rounded corners.
const CardShell = styledComponent('section', {
    background: benchTheme.surface,
    border: `1px solid ${benchTheme.border}`,
    borderRadius: benchTheme.radius,
    boxShadow: benchTheme.shadow,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    // min-width: 0 lets the card shrink inside flex/grid rows without blowout
    minWidth: 0,
    // flexShrink: 0 — the card is a flex item inside the scrollable
    // PluginColumn (BenchDashboard.tsx, overflowY: 'auto'). With the default
    // flex-shrink: 1 AND overflow: 'hidden' (which zeroes the automatic
    // min-height), the card would shrink to the column's visible height and
    // CLIP its overflow at CardShell instead of overflowing — older benchmark
    // entries disappeared and no scrollbar ever appeared. Keeping the card at
    // its content height pushes the overflow into PluginColumn, whose
    // overflowY: 'auto' then shows the scrollbar.
    flexShrink: 0
} as React.CSSProperties);

// Optional header row: title above, subtitle + actions on the baseline row
const CardHeader = styledComponent('header', {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '16px 20px 12px 20px'
} as React.CSSProperties);

// Panel title — the only heading in the dashboard body (h3 under the page title)
const CardTitle = styledComponent('h3', {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.2,
    color: benchTheme.textPrimary,
    fontFamily: benchTheme.sansFont,
    letterSpacing: '-0.01em'
} as React.CSSProperties);

// Subtitle sits next to the title (rendered in the baseline row below)
const CardSubtitle = styledComponent('span', {
    fontSize: 12,
    lineHeight: 1.4,
    color: benchTheme.textSecondary,
    fontFamily: benchTheme.sansFont,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0
} as React.CSSProperties);

// Title + subtitle stack (title row, subtitle row)
const CardHeadingStack = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 2
} as React.CSSProperties);

// Hairline divider between header and body
const CardDivider = styledComponent('div', {
    height: 1,
    background: benchTheme.border,
    width: '100%'
} as React.CSSProperties);

// Body with standard inner padding (cards that are not full-bleed).
// The model panel is the only Card consumer now (header-less) — generous
// padding gives the page its breathing room.
const CardBodyPadded = styledComponent('div', {
    flex: 1,
    minHeight: 0,
    padding: '12px 24px 20px 24px'
} as React.CSSProperties);

// Flush body for tables/lists that manage their own padding
const CardBodyFlush = styledComponent('div', {
    flex: 1,
    minHeight: 0,
    padding: 0
} as React.CSSProperties);

export type CardProps = {
    // Panel title — omit for header-less cards (e.g. the plain stat tiles)
    title?: string;
    // Small muted caption shown under the title (e.g. "3 models · ranked by throughput")
    subtitle?: React.ReactNode;
    // Extra controls right-aligned in the header (rarely used)
    actions?: React.ReactNode;
    // Give the body the standard inner padding; false = full-bleed children
    padded?: boolean;
    // Card content
    children: React.ReactNode;
};

/** The shared card surface used by every dashboard panel. */
export const Card = React.memo((props: CardProps) => {
    const { title, subtitle, actions, padded = true, children } = props;

    return (
        <CardShell>
            {/* Header only renders with a title — header-less cards skip the divider too */}
            {title ? (
                <React.Fragment>
                    <CardHeader>
                        <CardHeadingStack>
                            <CardTitle>{title}</CardTitle>
                            {subtitle ? <CardSubtitle>{subtitle}</CardSubtitle> : null}
                        </CardHeadingStack>
                    </CardHeader>
                    <CardDivider />
                </React.Fragment>
            ) : null}

            {/* flush body for full-bleed table/timeline layouts, padded otherwise */}
            {padded ? (
                <CardBodyPadded>{children}</CardBodyPadded>
            ) : (
                <CardBodyFlush>{children}</CardBodyFlush>
            )}
        </CardShell>
    );
});