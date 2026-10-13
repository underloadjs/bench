// dashboard/utilities/derive.ts — dashboard-level derived statistics.
//
// These functions take a LIST of BenchmarkReports (one per model) and compute
// the cross-model figures shown in the stats row and bottom bar. Keep them pure
// so they are trivially testable and reusable outside React.
//
// Cross-model averaging convention: each model contributes via its OWN summary
// (e.g. avgTtft), so a model benchmarked 20× doesn't drown one benchmarked
// 3× in the fleet-wide stat — every model counts equally.

import { isValid } from '@presource/core';
import type { BenchmarkReport } from '../../core';

// The cross-model derived stat block consumed by BottomBar.
// Fields are 0 / null when no reports exist so the UI renders em-dashes.
export type BenchDerivedStats = {
    // Model (identifier) with the highest average throughput, or null
    topModel: string | null;
    // Its average throughput, tokens/second (0 when no reports)
    topThroughput: number;
    // Best (lowest) average TTFT across models, seconds (null when no reports)
    fastestTtft: number | null;
    // Fleet-wide average TTFT = mean of each model's avgTtft, seconds
    avgTtft: number;
    // Fleet-wide average throughput = mean of each model's throughput, tokens/s
    avgThroughput: number;
    // Total of all runCount across reports
    totalRuns: number;
    // Total of all completedRuns across reports
    totalCompleted: number;
    // How many distinct models have reports
    modelCount: number;
    // Longest single benchmark wall time across reports, seconds
    maxWallTime: number;
};

// Arithmetic mean of a non-empty-safe list (0 for empty).
const avg = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

/**
 * Derives cross-model dashboard statistics from a list of benchmark reports.
 * @param reports - One BenchmarkReport per benchmarked model.
 */
export const deriveBenchStats = (reports: BenchmarkReport[]): BenchDerivedStats => {
    // Drop nullish entries defensively (a half-built report should not crash the UI)
    const valid = reports.filter((r) => isValid(r)) as BenchmarkReport[];

    if (valid.length === 0) {
        // Degenerate state: everything empty
        return {
            topModel: null,
            topThroughput: 0,
            fastestTtft: null,
            avgTtft: 0,
            avgThroughput: 0,
            totalRuns: 0,
            totalCompleted: 0,
            modelCount: 0,
            maxWallTime: 0
        };
    }

    // Identify the throughput champion (ties → first wins, deterministic order)
    let top = valid[0];
    for (const report of valid) {
        if (report.summary.throughput > top.summary.throughput) top = report;
    }

    // Best TTFT = minimum of per-model AVERAGES (not raw-run min) so one lucky
    // fast run on a slow model can't win the "fastest" medal.
    const perModelTtft = valid.map((r) => r.summary.avgTtft);
    // A model with zero completed runs reports avgTtft = 0 and must NOT look
    // "fastest" — exclude zero readings from the comparison.
    const positiveTtft = perModelTtft.filter((v) => v > 0);

    return {
        topModel: top.model,
        topThroughput: top.summary.throughput,
        // No model produced any reading (all-failed fleet) → nothing is fastest
        fastestTtft: positiveTtft.length === 0 ? null : Math.min(...positiveTtft),
        avgTtft: avg(perModelTtft),
        avgThroughput: avg(valid.map((r) => r.summary.throughput)),
        totalRuns: valid.reduce((sum, r) => sum + r.summary.runCount, 0),
        totalCompleted: valid.reduce((sum, r) => sum + r.summary.completedRuns, 0),
        modelCount: valid.length,
        maxWallTime: Math.max(...valid.map((r) => r.wallTime))
    };
};

/**
 * Resolves which report's model id should be preselected.
 * Preference: explicit selection → throughput champion → first report.
 */
export const defaultSelectedModel = (reports: BenchmarkReport[], fallback?: string | null): string | null => {
    // Explicit selection wins when it still exists among the reports
    if (fallback && reports.some((r) => r.model === fallback)) return fallback;
    const stats = deriveBenchStats(reports);
    return stats.topModel;
};