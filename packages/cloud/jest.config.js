/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  // vectorSearch.ts now lives in packages/shared and imports 'fs-extra' from there, which
  // resolves to a different module instance than the one this package's tests mock (cloud has
  // its own local copy in node_modules). Force both to the same resolved module so
  // jest.mock('fs-extra', ...) in test/vectorSearch.test.ts applies to the shared module too.
  moduleNameMapper: {
    '^fs-extra$': require.resolve('fs-extra'),
  },
};
