// dashboard/utilities/format.ts — display formatting helpers.
//
// Every metric shown in the dashboard funnels through these so precision and
// fallbacks are declared once. The em-dash convention keeps "no data" cells
// visually quiet instead of showing "0.00" or "NaN":
// the engine encodes "no reading" as the number 0 (see the BenchSummary
// zero-degradation rule), and @presource/core's isEmpty() does NOT count the
// *number* 0 as empty (only NaN does), so hasReading() below encodes the
// dashboard's convention: a value displays only when positive and finite.

import { numberEnsures } from '@presource/core';

// True only for a finite, positive number — the dashboard's "has a reading" test
const hasReading = (value: unknown): value is number => typeof value === 'number' && !Number.isNaN(value) && value > 0;

/** Formats a seconds value. 0/invalid/null → '—' (no-data convention). */
export const formatSeconds = (value: number | null | undefined, digits = 2): string => {
    if (!hasReading(value)) return '—';
    return `${value.toFixed(digits)}s`;
};

/** Formats a tokens/second value. 0/invalid/null → '—'. */
export const formatTokensPerSec = (value: number | null | undefined, digits = 1): string => {
    if (!hasReading(value)) return '—';
    return `${value.toFixed(digits)} tok/s`;
};

/** Formats a raw count (runs, tokens). 0/invalid/null → '—', otherwise thousands grouping. */
export const formatCount = (value: number | null | undefined): string => {
    if (!hasReading(value)) return '—';
    return new Intl.NumberFormat('en-US').format(Math.trunc(numberEnsures(value)));
};

/** Formats a 0..1 ratio as a percentage integer ("87%"). 0/invalid/null → '—'. */
export const formatPercent = (value: number | null | undefined): string => {
    if (!hasReading(value)) return '—';
    return `${Math.round(value * 100)}%`;
};

/** Truncates a prompt for compact display surfaces (header/bottom bar). */
export const truncateText = (value: string, maxLength = 90): string => {
    if (!value) return '';
    // Cheap ellipsis: cut then append '…' (single char, no layout surprises)
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
};