// The product title ("Bench v1.1.0(081345)") is composed at build time by
// vite.config.ts / vitest.config.ts from package.json's version (__APP_VERSION__)
// and the build machine's clock (__APP_BUILD_STAMP__, see src/build-stamp.ts).
// These tests pin the stamp formatter, constructing Dates from local fields so
// they never depend on the machine's zone or on when the suite runs.

import { describe, expect, it } from 'vitest';
import { formatBuildStamp } from './build-stamp';

describe('formatBuildStamp', () => {
    it('formats a timestamp as two-digit day, hour and minute', () => {
        // Local-field construction: the stamp reads the same fields, so these
        // expectations hold in every timezone.
        expect(formatBuildStamp(new Date(2026, 10, 24, 12, 0, 0))).toBe('241200');
        expect(formatBuildStamp(new Date(2026, 10, 8, 23, 59, 59))).toBe('082359');
    });

    it('pads single-digit days, hours and minutes', () => {
        expect(formatBuildStamp(new Date(2030, 0, 5, 9, 7, 0))).toBe('050907');
        expect(formatBuildStamp(new Date(2027, 11, 31, 0, 0, 0))).toBe('310000');
    });

    it('uses the build machine clock, not a UTC-shifted one', () => {
        // 00:30 local is 00:30 on the stamp, whatever the zone offset is.
        expect(formatBuildStamp(new Date(2026, 10, 9, 0, 30, 0))).toBe('090030');
    });
});
