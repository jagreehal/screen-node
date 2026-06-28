#!/usr/bin/env node
// Launcher for `sandbox-bun` / `sbun`. See bin/pnpm.mjs for why the leader rides an env var.
process.env.SCREEN_PM_BIN = 'bun';
await import(new URL('../dist/cli.mjs', import.meta.url).href);
