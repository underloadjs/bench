// dashboard/context/store.test.ts — the benchmark-entry DELETION rules.
//
// The rules live in the pure helper (withoutEntryRecord) so they are testable
// without mounting the React tree; the useBenchDashboard `deleteEntry` action
// is a plain write-through over it (App.test.tsx covers that wiring through the
// entry card's hover DELETE chip).
//
// The contract: only a SETTLED entry — CANCELLED or COMPLETED — is deletable,
// never a RUNNING one, and the fleet roll-up (`reports`, latest per model)
// stays consistent with the entries that are left.
import { describe, expect, it } from 'vitest';
import type { BenchmarkReport } from '../../core';
import { isEntrySettled, withoutEntryRecord, type BenchEntry } from './store';

// Fixture builders. The helper reads only entry id/status/report + report.model
// (+ report.runs to shape a believable cancelled record), so the reports are
// stubbed down to those fields (cast — no summary arithmetic happens here).
const reportFor = (model: string, errors: Array<string | undefined> = []): BenchmarkReport =>
    ({
        model,
        runs: errors.map((error, index) => ({ index, error }))
    }) as unknown as BenchmarkReport;

const entryFor = (id: string, patch: Partial<BenchEntry> = {}): BenchEntry => ({
    id,
    model: 'm',
    modelLabel: 'm',
    scenarioId: 'short-story',
    scenarioLabel: 'Short Story',
    prompt: 'p',
    iterations: 3,
    concurrency: 1,
    // Settled by default — a running entry is the exception under test
    status: 'done',
    progress: { completed: 3, failed: 0, total: 3 },
    streaming: [],
    report: reportFor('m'),
    ...patch
});

describe('isEntrySettled', () => {
    it('marks cancelled/completed entries deletable and running ones not', () => {
        // COMPLETED: settled with clean runs
        expect(isEntrySettled(entryFor('bench-1'))).toBe(true);
        // CANCELLED: settles 'done' with its runs recorded as 'cancelled'
        expect(
            isEntrySettled(entryFor('bench-2', { report: reportFor('m', ['cancelled', 'cancelled']) }))
        ).toBe(true);
        // RUNNING: still landing runs → not deletable
        expect(isEntrySettled(entryFor('bench-3', { status: 'running' }))).toBe(false);
        // Unknown id (no entry) → not deletable
        expect(isEntrySettled(undefined)).toBe(false);
    });
});

describe('withoutEntryRecord', () => {
    it('deletes a completed entry and falls the model back to the newest remaining report', () => {
        // NEWEST FIRST (the store prepends): the newer entry's report is the
        // one feeding the roll-up right now
        const older = entryFor('bench-1', { report: reportFor('m') });
        const newest = entryFor('bench-2', { report: reportFor('m') });
        const entries = [newest, older];
        const reports = [newest.report as BenchmarkReport];

        const next = withoutEntryRecord(entries, reports, 'bench-2');

        // The deleted entry leaves the column…
        expect(next.entries).toEqual([older]);
        // …and the roll-up re-points at the newest remaining entry for the model
        expect(next.reports).toEqual([older.report]);
        expect(next.reports[0]).toBe(older.report);
    });

    it('deletes a cancelled entry and drops the model from the roll-up when nothing else carries it', () => {
        const cancelled = entryFor('bench-2', {
            // Cancelled mid-run: 0/3 ok, every recorded run is 'cancelled'
            progress: { completed: 2, failed: 2, total: 3 },
            report: reportFor('m', ['cancelled', 'cancelled'])
        });
        const other = entryFor('bench-1', { model: 'n', report: reportFor('n') });
        const entries = [cancelled, other];
        const reports = [cancelled.report as BenchmarkReport, other.report as BenchmarkReport];

        const next = withoutEntryRecord(entries, reports, 'bench-2');

        expect(next.entries).toEqual([other]);
        // The cancelled entry was the only record for model 'm' → 'm' leaves the
        // fleet stats; the untouched model 'n' stays
        expect(next.reports.map((report) => report.model)).toEqual(['n']);
    });

    it('refuses a running entry — the entries and reports come back unchanged', () => {
        const running = entryFor('bench-2', { status: 'running' });
        const done = entryFor('bench-1');
        const entries = [running, done];
        const reports = [done.report as BenchmarkReport];

        const next = withoutEntryRecord(entries, reports, 'bench-2');

        // SAME references back: the delete is refused, so the store action
        // detects it and writes nothing (a mid-flight card stays on record)
        expect(next.entries).toBe(entries);
        expect(next.reports).toBe(reports);
    });

    it('ignores an unknown id', () => {
        const entries = [entryFor('bench-1')];
        const reports = [entries[0].report as BenchmarkReport];

        const next = withoutEntryRecord(entries, reports, 'bench-does-not-exist');

        expect(next.entries).toBe(entries);
        expect(next.reports).toBe(reports);
    });

    it('leaves the roll-up untouched when the deleted entry never produced a report', () => {
        // A scenario whose execute threw before any run settled: the entry
        // carries no report, so it never fed the fleet stats
        const blank = entryFor('bench-2', { report: null });
        const seeded = entryFor('bench-1', { report: null });
        const entries = [blank, seeded];
        const reports = [reportFor('m')];

        const next = withoutEntryRecord(entries, reports, 'bench-2');

        expect(next.entries).toEqual([seeded]);
        // SAME reference back — the seeded report stays exactly as injected
        expect(next.reports).toBe(reports);
    });
});
