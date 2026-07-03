module.exports = {
  extends: ['wowarenalogs'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    // Tray app: console output is the log surface (mirrors tools/windows-agent).
    'no-console': 'off',
  },
};
