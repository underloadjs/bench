// dashboard/utilities/derive.test.ts — exact-value tests for the dashboard's
// cross-model stat derivation and display formatting.
//
// deriveBenchStats is exercised against the SHIP sample fixtures
// (dashboard/sample.ts, themselves built through the real summarizeRuns) so
// the expected numbers below are the genuine engine outputs — captured, not
// approximated. format helpers pin the no-data em-dash convention (0 → '—').
import { describe, expect, it } from 'vitest';
import { deriveBenchStats } from './derive';
import { defaultSelectedModel } from './derive';
import { formatSeconds, formatTokensPerSec, formatCount, formatPercent, truncateText } from './format';
import { sampleReports } from '../sample';

describe('deriveBenchStats', () => {
    it('derives fleet stats exactly from the sample reports', () => {
        // qwen is the throughput champion (135.13741434668762 tok/s); deepseek
        // contributes the only failed iteration (6/7), hence 18/19 runs.
        expect(deriveBenchStats(sampleReports)).toEqual({
            topModel: 'qwen3.8-27b',
            topThroughput: 135.13741434668762,
            // qwen's average TTFT (exact double — not the clean 0.485)
            fastestTtft: 0.48499999999999993,
            avgTtft: 0.63,
            avgThroughput: 120.25848471662762,
            totalRuns: 19,
            totalCompleted: 18,
            modelCount: 3,
            maxWallTime: 67.9
        });
    });

    it('returns the degenerate zero shape for no reports', () => {
        expect(deriveBenchStats([])).toEqual({
            topModel: null,
            topThroughput: 0,
            fastestTtft: null,
            avgTtft: 0,
            avgThroughput: 0,
            totalRuns: 0,
            totalCompleted: 0,
            modelCount: 0,
            maxWallTime: 0
        });
    });

    it('defaultSelectedModel honours an existing selection, else the champion', () => {
        // Explicit selection that exists among the reports wins
        expect(defaultSelectedModel(sampleReports, 'glm-5.2')).toBe('glm-5.2');
        // Selection pointing at a removed model falls through to the champion
        expect(defaultSelectedModel(sampleReports, 'ghost/model')).toBe('qwen3.8-27b');
        // No selection, reports present → champion
        expect(defaultSelectedModel(sampleReports, null)).toBe('qwen3.8-27b');
        // Nothing at all → null
        expect(defaultSelectedModel([], null)).toBe(null);
    });
});

describe('format helpers', () => {
    it('formats seconds with the no-data em-dash convention (0 → —)', () => {
        expect(formatSeconds(0.417)).toBe('0.42s');
        expect(formatSeconds(0.417, 3)).toBe('0.417s');
        expect(formatSeconds(0)).toBe('—');
        expect(formatSeconds(NaN)).toBe('—');
        expect(formatSeconds(null)).toBe('—');
        expect(formatSeconds(undefined)).toBe('—');
    });

    it('formats throughput values', () => {
        expect(formatTokensPerSec(112.50000000000001)).toBe('112.5 tok/s');
        expect(formatTokensPerSec(0)).toBe('—');
    });

    it('groups counts with thousands separators and em-dash on no-data', () => {
        expect(formatCount(1234567)).toBe('1,234,567');
        expect(formatCount(0)).toBe('—');
    });

    it('renders ratios as percentage integers', () => {
        expect(formatPercent(0.8571428571428571)).toBe('86%');
        expect(formatPercent(1)).toBe('100%');
        expect(formatPercent(0)).toBe('—');
    });

    it('truncates long prompts with a trailing ellipsis character', () => {
        expect(truncateText('abcdefgh', 5)).toBe('abcde…');
        expect(truncateText('short')).toBe('short');
        expect(truncateText('')).toBe('');
    });
});