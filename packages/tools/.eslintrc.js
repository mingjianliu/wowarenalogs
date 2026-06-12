module.exports = {
  extends: ['wowarenalogs'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    // These are internal CLI/dev scripts whose primary output is the console
    // (mirrors the cloud-functions package, which also disables this rule).
    'no-console': 'off',
  },
};
