/**
 * Nub's plugin protocol runs `nub-screen` for `nub screen ...`. The plugin exposes screen-node's
 * complementary security commands, while Nub keeps ownership of its built-in installer, runner,
 * and build approval. Passing an install verb through to the ordinary screen CLI would silently run
 * npm/pnpm/yarn/bun instead of Nub, so the boundary is explicit and unit-tested here.
 */

export type NubPluginDecision =
  | { kind: 'help' }
  | { kind: 'delegate' }
  | { kind: 'reject'; command: string; message: string };

const SCREEN_SECURITY_COMMANDS = new Set([
  'init',
  'setup',
  'allow',
  'doctor',
  'verify',
  'verify-receipt',
  'keygen',
  'scan',
  'secrets',
  'feeds',
  'badge',
  'delta',
  'check',
  'preflight',
  'audit',
]);

/** Global screen flags that consume the next argv token. */
const VALUE_FLAGS = new Set(['--config', '--format', '--env', '--env-from', '--env-file', '--risk', '--min-release-age', '--allow-recent']);

/** Find the screen command after any global flags Nub forwarded to the plugin. */
export function nubPluginCommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return undefined;
}

const NUB_EQUIVALENTS: Record<string, string> = {
  install: 'nub install',
  add: 'nub add <pkg>',
  remove: 'nub remove <pkg>',
  update: 'nub update',
  upgrade: 'nub update',
  'approve-builds': 'nub approve-builds',
  run: 'nub run <script>',
  script: 'nub run <script>',
  dev: 'nub run dev',
  x: 'nubx <pkg>',
};

export function nubPluginDecision(argv: string[]): NubPluginDecision {
  if (argv.some((token) => token === '--version' || token === '-v' || token === '-V')) return { kind: 'delegate' };
  const command = nubPluginCommand(argv);
  if (!command || command === 'help') return { kind: 'help' };
  if (command === '--help' || command === '-h') return { kind: 'help' };
  // The screen CLI's detached update checker re-enters through the same executable path.
  if (command === '__update-check' || SCREEN_SECURITY_COMMANDS.has(command) || command === 'version') return { kind: 'delegate' };

  const equivalent = NUB_EQUIVALENTS[command];
  if (equivalent) {
    return {
      kind: 'reject',
      command,
      message: `Nub owns '${command}'. Run \`${equivalent}\` directly. Use \`nub screen check <pkg>\` first when you want screen-node's additional feed, typosquat, and registry-risk review.`,
    };
  }
  return {
    kind: 'reject',
    command,
    message: `unknown nub-screen command '${command}'. Run \`nub screen help\` for the supported security commands.`,
  };
}

export const NUB_PLUGIN_HELP = `nub-screen: screen-node security commands inside Nub

Usage: nub screen <command> [args]

Review and policy:
  check [pkg...]        review packages without installing
  preflight [pm cmd]    mirror a package-manager command without installing
  scan                  re-check locked versions for current malware reports
  delta [--base ref]    gate dependency changes introduced by a branch
  secrets [path]        scan committed files for credentials
  verify [options]      verify committed screen policy and optional checks

Configuration and diagnostics:
  init · setup · allow · feeds · doctor · badge
  verify-receipt · keygen · audit verify

Nub keeps ownership of install, add, remove, update, run, nubx, and approve-builds.
For example: nub screen check zod && nub add zod
`;
