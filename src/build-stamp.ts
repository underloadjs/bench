// Build stamp for the versioned product title: "Bench v1.1.0(081345)".
//
// WHY THIS IS COMPUTED AT BUILD TIME (vite.config.ts / vitest.config.ts), NOT
// HERE: the label names the ARTIFACT that was built. The package version is
// already injected that way (`__APP_VERSION__`, see src/version.ts); the stamp
// joins it as `__APP_BUILD_STAMP__`. A `new Date()` in the browser would print
// the VISITOR's clock and drift away from the deployed bundle, and a local build
// could disagree with the Pages build. Both configs read this one formatter so
// dev, build and tests all produce the same stamp shape.
//
// This module stays pure so the format is testable with a pinned timestamp
// (build-stamp.test.ts) instead of freezing the clock.

/**
 * Two-digit day, hour and minute (DDHHMM) of the machine running the build:
 * 2026-11-24 09:05 -> "240905".
 *
 * DDHHMM names the BUILD, not the calendar date: it is unique per minute
 * within a day, but two builds at the same time on the 8th of different months
 * look identical. That is the intended reading of "day, hour, minute".
 *
 * Reads the LOCAL clock, i.e. "now" on the build host. GitHub Actions runners
 * are UTC, so a CI build stamps the UTC day and time of the run; a local build
 * stamps the developer's local clock.
 */
export const formatBuildStamp = (date: Date): string => {
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${day}${hour}${minute}`;
};
