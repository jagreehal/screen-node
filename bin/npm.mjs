#!/usr/bin/env node
// Launcher for `sandbox-npm` / `snpm`. See bin/pnpm.mjs for why the leader rides an env var.
process.env.SCREEN_PM_BIN = 'npm';
await import(new URL('../dist/cli.mjs', import.meta.url).href);
