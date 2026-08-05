#!/usr/bin/env node
// Nub resolves `nub screen ...` to this executable through its git/cargo-style plugin protocol.
// Keep install verbs in Nub; this launcher delegates only screen-node's complementary security CLI.
import { NUB_PLUGIN_HELP, nubPluginDecision } from '../dist/index.mjs';

const decision = nubPluginDecision(process.argv.slice(2));
switch (decision.kind) {
  case 'help':
    process.stdout.write(NUB_PLUGIN_HELP);
    break;
  case 'delegate':
    // Nub identity uses lock.yaml, which is byte-for-byte pnpm v9. Tell the read-only screen paths
    // to use that filename without teaching ordinary `screen install` to mistake Nub for pnpm.
    process.env.SCREEN_NUB_PLUGIN = '1';
    await import(new URL('../dist/cli.mjs', import.meta.url).href);
    break;
  case 'reject':
    process.stderr.write(`nub-screen: ${decision.message}\n`);
    process.exitCode = 2;
    break;
}
