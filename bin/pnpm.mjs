#!/usr/bin/env node
// Launcher for `sandbox-pnpm` / `spnpm`. A package-manager shim can re-exec us via `node <path>`,
// losing argv[0] (the bin name), so we can't rely on it to know which PM to front. Set the leader
// explicitly via env, then hand off to the real CLI. The CLI reads SANDBOX_PM_BIN as the leader.
process.env.SANDBOX_PM_BIN = 'pnpm';
await import(new URL('../dist/cli.mjs', import.meta.url).href);
