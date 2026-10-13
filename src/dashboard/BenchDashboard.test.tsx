// dashboard/BenchDashboard.test.tsx — interaction tests for the dashboard.
//
// Runs every story through @library/test's storybookTestRunner (same runner
// used by TwoColumnDashboard / WebstormDashboard and the rest of the repo's
// storybook-tested components), which renders each story and executes its
// play function under vitest/jsdom.
import * as stories from './BenchDashboard.stories';
import { storybookTestRunner } from '@library/test';

// Standard storybook interaction test for the Bench dashboard.
describe('BenchDashboard Interaction Test', () => {
    // All three canonical states (Overview / Running / Empty) must render
    storybookTestRunner(stories);
});