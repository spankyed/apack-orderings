// Every mutant of the scheduler is run against its specs, and one that survives fails the run: a line no spec would
// notice changing is a line nothing holds. A mutant that changes nothing anyone could see is switched off where it
// is, with why.
//
//   npm run mutants
export default {
  testRunner: 'vitest',
  // The specs in Node: a browser is not opened for each mutant.
  vitest: { configFile: 'vitest.mutants.ts' },
  mutate: ['src/**/*.ts'],
  coverageAnalysis: 'perTest',
  ignoreStatic: false,
  reporters: ['progress', 'clear-text'],
  thresholds: { high: 100, low: 100, break: 100 },
  timeoutMS: 10_000,
  tempDirName: '.stryker-tmp',
}
