// dashboard/components/Card.test.tsx — layout regression tests for the card
// surface.
//
// THE REGRESSION (older bench entries hidden, no scrollbar): the model panel's
// <Card> is a flex item inside the scrollable PluginColumn
// (dashboard/BenchDashboard.tsx — flex column, overflowY: 'auto'). With the
// flex default `flex-shrink: 1` AND CardShell's `overflow: 'hidden'` (which
// zeroes the automatic min-height of a flex item), the card shrank to the
// column's visible height and clipped its overflow at the card boundary —
// older benchmark entries silently disappeared and PluginColumn's scrollbar
// never appeared because nothing overflowed the COLUMN.
//
// The fix pins `flexShrink: 0` on CardShell so the card keeps its content
// height; overflow then reaches PluginColumn, whose overflowY: 'auto' shows
// the scrollbar.
import { describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { Card } from './Card';

describe('Card layout', () => {
    it('does not shrink inside a constrained flex column (entries must overflow, not clip)', () => {
        // Reproduces the PluginColumn environment: a fixed-height flex column
        // (the scroll container) whose flex children could previously shrink
        const ScrollColumn = (props: { children: React.ReactNode }) => (
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    height: 300,
                    overflowY: 'auto'
                }}
            >
                {props.children}
            </div>
        );

        const { container } = render(
            <ScrollColumn>
                <Card>
                    <div data-testid="tall-content" style={{ height: 900 }}>
                        tall content
                    </div>
                </Card>
            </ScrollColumn>
        );

        // The card section (CardShell) is the column's direct flex item
        const cardShell = container.querySelector('section')!;
        expect(cardShell).toBeTruthy();

        const shellStyle = window.getComputedStyle(cardShell);
        // THE FIX: flex-shrink must be 0 — with the default 1 (plus
        // overflow: hidden zeroing the automatic min-height) the card
        // collapsed to 300px and clipped the entries
        expect(shellStyle.flexShrink).toBe('0');
        // The clipping boundary stays on the card (rounded-corner clipping)
        expect(shellStyle.overflow).toBe('hidden');

        // The scroll COLUMN must be the scroll container — its content
        // (the un-shrunk card + tall body) overflows it, not the card
        const column = container.firstElementChild as HTMLElement;
        expect(window.getComputedStyle(column).overflowY).toBe('auto');

        cleanup();
    });

    it('keeps the padded body at content height (min-height 0, flex 1)', () => {
        const { container } = render(
            <Card>
                <div data-testid="body-content">content</div>
            </Card>
        );

        // Padded body: the div directly wrapping the children
        const body = container.querySelector('section > div') as HTMLElement;
        expect(body).toBeTruthy();
        const bodyStyle = window.getComputedStyle(body);
        expect(bodyStyle.minHeight).toBe('0px');
        expect(bodyStyle.flexGrow).toBe('1');

        cleanup();
    });
});
