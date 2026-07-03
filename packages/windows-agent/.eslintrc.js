module.exports = {
  extends: ['wowarenalogs'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    // Standalone CLI agent: console output is the primary interface
    // (mirrors the tools package, which disables this rule for the same reason).
    'no-console': 'off',
  },
};
