#!/usr/bin/env node
// Launcher for `sandbox-npx` / `snpx`. See bin/pnpm.mjs for why the leader rides an env var.
process.env.SANDBOX_PM_BIN = 'npx';
await import(new URL('../dist/cli.mjs', import.meta.url).href);
