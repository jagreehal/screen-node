#!/usr/bin/env node
// Launcher for `sandbox-bunx` / `sbunx`. See bin/pnpm.mjs for why the leader rides an env var.
process.env.SCREEN_PM_BIN = 'bunx';
await import(new URL('../dist/cli.mjs', import.meta.url).href);
