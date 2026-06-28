import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stripJsonComments } from './config.js';

/**
 * The host-side enforcement layer. `.sandbox/AGENT.md` *asks* the agent to use
 * `sandbox install`; a `PreToolUse` hook *enforces* it. The README's own honest
 * critique was that the AGENT.md instruction is advisory — it relies on the model
 * complying. This hook makes the boundary real: the host Claude literally cannot run a
 * bare `npm install`/`pnpm add`/`npx …` without going through containment, because the
 * tool call is denied before it executes.
 *
 * This governs the agent running ON THE HOST (the project's `.claude/settings.json`). It
 * is the lightweight half of the story — for full agent isolation, run the agent inside a
 * generated devcontainer instead (see `sandbox devcontainer init`).
 */

/** Package managers whose mutating/exec subcommands run untrusted dependency code. */
const PMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Runners that fetch-and-execute a package — always dangerous, no safe subcommand. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx']);

/**
 * Subcommands that install dependencies or execute project/dependency code — the ones
 * that must go through containment. Read-only queries (`ls`, `view`, `outdated`, …) are
 * deliberately *not* here, so day-to-day inspection isn't blocked.
 */
const DANGEROUS_SUBCOMMANDS = new Set([
  'install', 'i', 'ci', 'add', 'run', 'run-script', 'test', 't', 'start', 'exec',
  'dlx', 'create', 'x', 'rebuild', 'update', 'up', 'upgrade', 'link', 'unlink', 'install-test',
  'uninstall', 'remove', 'rm', 'un', 'dedupe', 'ddp',
]);

/** Leading tokens that prefix the real command without changing what it is. */
const PREFIX_TOKENS = new Set(['sudo', 'command', 'exec', 'time', 'nice', 'env']);

/** Split a shell command line into segments on `&&`, `||`, `;`, `|`, and newlines. */
function splitSegments(command: string): string[] {
  return command
    .split(/\n|&&|\|\||;|\|/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Drop leading `VAR=value` assignments, benign prefixes (`sudo`, …), and `cd <path>`. */
function programTokens(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; } // env assignment
    if (PREFIX_TOKENS.has(t)) { i++; continue; }
    if (t === 'cd') { i += 2; continue; } // skip `cd <path>`
    break;
  }
  return tokens.slice(i);
}

function reason(command: string): string {
  const rerun = suggestSandboxCommand(command);
  return [
    'Blocked by sandbox: run package-manager commands through `sandbox` so install/run',
    'happens inside containment (host credentials stay out, egress is default-deny).',
    '',
    `Re-run it as:  ${rerun}`,
    '',
    'Examples: `sandbox install`, `sandbox add zod`, `sandbox dev`, `sandbox x vite`.',
    'If you genuinely need to bypass containment once, ask the user to run the command themselves.',
  ].join('\n');
}

function quoteArgs(tokens: string[]): string {
  return tokens
    .map((token) => (/^[A-Za-z0-9_./:@+-]+$/.test(token) ? token : JSON.stringify(token)))
    .join(' ');
}

function explicitPassthrough(tokens: string[]): string {
  return `sandbox ${quoteArgs(tokens)}`;
}

function hasFlags(tokens: string[]): boolean {
  return tokens.some((token) => token.startsWith('-'));
}

function suggestSandboxCommand(command: string): string {
  const tokens = programTokens(command.trim());
  const program = tokens[0];
  const sub = tokens[1];
  if (!program) return 'sandbox install';

  if (RUNNERS.has(program)) {
    const args = tokens.slice(1);
    if (args.length === 0 || hasFlags(args)) return explicitPassthrough(tokens);
    return `sandbox x ${quoteArgs(args)}`;
  }

  if (!PMS.has(program)) return explicitPassthrough(tokens);
  if (program === 'yarn' && !sub) return 'sandbox install';
  if (!sub) return explicitPassthrough(tokens);

  const after = tokens.slice(2);
  if (sub === 'install' || sub === 'i' || sub === 'add') {
    if (hasFlags(after)) return explicitPassthrough(tokens);
    const hasNamedPackages = after.some((token) => token.length > 0 && !token.startsWith('-'));
    if (hasNamedPackages) return `sandbox add ${quoteArgs(after)}`;
    return 'sandbox install';
  }
  if (sub === 'ci') return explicitPassthrough(tokens);
  if (sub === 'update' || sub === 'up' || sub === 'upgrade') {
    if (hasFlags(after)) return explicitPassthrough(tokens);
    return after.length > 0 ? `sandbox update ${quoteArgs(after)}` : 'sandbox update';
  }
  if (sub === 'remove' || sub === 'rm' || sub === 'uninstall' || sub === 'un') {
    if (hasFlags(after)) return explicitPassthrough(tokens);
    return after.length > 0 ? `sandbox remove ${quoteArgs(after)}` : 'sandbox remove';
  }
  if (sub === 'test' || sub === 't') return hasFlags(after) ? explicitPassthrough(tokens) : (after.length > 0 ? `sandbox test ${quoteArgs(after)}` : 'sandbox test');
  if (sub === 'run' && after[0] === 'dev') {
    if (hasFlags(after.slice(1))) return explicitPassthrough(tokens);
    return after.length > 1 ? `sandbox dev ${quoteArgs(after.slice(1))}` : 'sandbox dev';
  }
  if (sub === 'run' && after[0] === 'test') {
    if (hasFlags(after.slice(1))) return explicitPassthrough(tokens);
    return after.length > 1 ? `sandbox test ${quoteArgs(after.slice(1))}` : 'sandbox test';
  }
  if (sub === 'exec' || sub === 'dlx' || sub === 'x') {
    if (after.length === 0 || hasFlags(after)) return explicitPassthrough(tokens);
    return `sandbox x ${quoteArgs(after)}`;
  }
  return explicitPassthrough(tokens);
}

export interface HookDecision {
  block: boolean;
  reason?: string;
}

/**
 * Decide whether a Bash command should be blocked for not going through `sandbox`.
 * Pure and side-effect free so it can be unit-tested; the shipped hook script mirrors it.
 *
 * Blocks when any segment invokes a package-manager install/exec subcommand, or a
 * fetch-and-run runner (`npx`/`bunx`/`pnpx`), or a bare `yarn` (which means install) —
 * unless that segment is already prefixed with `sandbox`.
 */
export function classifyBareCommand(command: string): HookDecision {
  for (const segment of splitSegments(command)) {
    const tokens = programTokens(segment);
    const program = tokens[0];
    if (!program) continue;
    if (program === 'sandbox' || program === 'sandbox-node') continue; // already contained
    if (RUNNERS.has(program)) return { block: true, reason: reason(segment) };
    if (PMS.has(program)) {
      const sub = tokens[1];
      if (program === 'yarn' && !sub) return { block: true, reason: reason(segment) }; // bare `yarn` = install
      if (sub && DANGEROUS_SUBCOMMANDS.has(sub)) return { block: true, reason: reason(segment) };
    }
  }
  return { block: false };
}

/**
 * The self-contained hook script written into the repo. It has no imports, so it runs
 * regardless of whether the package is installed locally, and the user can read exactly
 * what gates their commands. Keep its logic in lockstep with {@link classifyBareCommand};
 * `test/hook.test.ts` runs both against the same table to catch drift.
 */
export const HOOK_SCRIPT = `#!/usr/bin/env node
// Generated by \`sandbox init --agent\`. Enforces that package-manager commands run
// through \`sandbox\` (install/run inside containment). Edit sandbox.config.json, not this.
const PMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const DANGEROUS = new Set(['install','i','ci','add','run','run-script','test','t','start','exec','dlx','create','x','rebuild','update','up','upgrade','link','unlink','install-test','uninstall','remove','rm','un','dedupe','ddp']);
const PREFIX = new Set(['sudo','command','exec','time','nice','env']);

function programTokens(segment) {
  const tokens = segment.split(/\\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (PREFIX.has(t)) { i++; continue; }
    if (t === 'cd') { i += 2; continue; }
    break;
  }
  return tokens.slice(i);
}

function classify(command) {
  const segments = command.split(/\\n|&&|\\|\\||;|\\|/g).map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const tokens = programTokens(segment);
    const program = tokens[0];
    if (!program) continue;
    if (program === 'sandbox' || program === 'sandbox-node') continue;
    if (RUNNERS.has(program)) return segment;
    if (PMS.has(program)) {
      const sub = tokens[1];
      if (program === 'yarn' && !sub) return segment;
      if (sub && DANGEROUS.has(sub)) return segment;
    }
  }
  return null;
}

function quoteArgs(tokens) {
  return tokens.map((token) => (/^[A-Za-z0-9_./:@+-]+$/.test(token) ? token : JSON.stringify(token))).join(' ');
}

function explicitPassthrough(tokens) {
  return 'sandbox ' + quoteArgs(tokens);
}

function hasFlags(tokens) {
  return tokens.some((token) => token.startsWith('-'));
}

function suggest(command) {
  const tokens = programTokens(command.trim());
  const program = tokens[0];
  const sub = tokens[1];
  if (!program) return 'sandbox install';

  if (RUNNERS.has(program)) {
    const args = tokens.slice(1);
    if (args.length === 0 || hasFlags(args)) return explicitPassthrough(tokens);
    return 'sandbox x ' + quoteArgs(args);
  }

  if (!PMS.has(program)) return explicitPassthrough(tokens);
  if (program === 'yarn' && !sub) return 'sandbox install';
  if (!sub) return explicitPassthrough(tokens);

  const after = tokens.slice(2);
  if (sub === 'install' || sub === 'i' || sub === 'add') {
    if (hasFlags(after)) return explicitPassthrough(tokens);
    const hasNamedPackages = after.some((token) => token.length > 0 && !token.startsWith('-'));
    if (hasNamedPackages) return 'sandbox add ' + quoteArgs(after);
    return 'sandbox install';
  }
  if (sub === 'ci') return explicitPassthrough(tokens);
  if (sub === 'update' || sub === 'up' || sub === 'upgrade') {
    if (hasFlags(after)) return explicitPassthrough(tokens);
    return after.length > 0 ? 'sandbox update ' + quoteArgs(after) : 'sandbox update';
  }
  if (sub === 'remove' || sub === 'rm' || sub === 'uninstall' || sub === 'un') {
    if (hasFlags(after)) return explicitPassthrough(tokens);
    return after.length > 0 ? 'sandbox remove ' + quoteArgs(after) : 'sandbox remove';
  }
  if (sub === 'test' || sub === 't') return hasFlags(after) ? explicitPassthrough(tokens) : (after.length > 0 ? 'sandbox test ' + quoteArgs(after) : 'sandbox test');
  if (sub === 'run' && after[0] === 'dev') {
    if (hasFlags(after.slice(1))) return explicitPassthrough(tokens);
    return after.length > 1 ? 'sandbox dev ' + quoteArgs(after.slice(1)) : 'sandbox dev';
  }
  if (sub === 'run' && after[0] === 'test') {
    if (hasFlags(after.slice(1))) return explicitPassthrough(tokens);
    return after.length > 1 ? 'sandbox test ' + quoteArgs(after.slice(1)) : 'sandbox test';
  }
  if (sub === 'exec' || sub === 'dlx' || sub === 'x') {
    if (after.length === 0 || hasFlags(after)) return explicitPassthrough(tokens);
    return 'sandbox x ' + quoteArgs(after);
  }
  return explicitPassthrough(tokens);
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let command = '';
  try { command = (JSON.parse(raw).tool_input || {}).command || ''; } catch {}
  const hit = classify(command);
  if (!hit) process.exit(0);
  process.stderr.write(
    'Blocked by sandbox: run package-manager commands through \`sandbox\` so install/run\\n' +
    'happens inside containment (host credentials stay out, egress is default-deny).\\n\\n' +
    'Re-run it as:  ' + suggest(hit) + '\\n\\n' +
    'Examples: \`sandbox install\`, \`sandbox add zod\`, \`sandbox dev\`, \`sandbox x vite\`.\\n' +
    'If you genuinely need to bypass containment once, ask the user to run the command themselves.\\n'
  );
  process.exit(2);
});
`;

const HOOK_REL = '.sandbox/hooks/enforce-sandbox.mjs';
const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.sandbox/hooks/enforce-sandbox.mjs"';

interface HookEntry {
  type: 'command';
  command: string;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

/**
 * Project secret files the host agent has no reason to *read*. The container hides host
 * credentials from the install, but when the agent itself runs on the host it could still
 * read these into its own context and leak them downstream. Denying them at the Claude Code
 * permission layer closes that gap. Deny always wins in Claude Code, so this is conservative:
 * it never grants anything, only refuses these reads. Remove a line if you need it read.
 */
export const SECRET_DENY_RULES = ['Read(./.env)', 'Read(./.env.*)', 'Read(./secrets/**)'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge our PreToolUse hook into a project `.claude/settings.json` without clobbering
 * anything else. Idempotent: re-running won't add a duplicate entry. Returns the parsed
 * settings object (caller writes it) so the merge stays pure and testable.
 */
export function mergePreToolUseHook(settings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings };
  const hooks = { ...(next.hooks as Record<string, unknown> | undefined) };
  const preToolUse = Array.isArray(hooks.PreToolUse) ? ([...hooks.PreToolUse] as HookMatcher[]) : [];

  const alreadyWired = preToolUse.some((m) => m.hooks?.some((h) => h.command?.includes('enforce-sandbox.mjs')));
  if (!alreadyWired) {
    preToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  }
  hooks.PreToolUse = preToolUse;
  next.hooks = hooks;
  return next;
}

/**
 * The full `.claude/settings.json` merge for the `agent` preset: the enforcement hook plus
 * the secret-file deny rules. Both are unioned into whatever the user already has, so it's
 * idempotent and never removes the user's own keys.
 */
export function mergeAgentSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const next = mergePreToolUseHook(settings);
  const permissions = { ...(next.permissions as Record<string, unknown> | undefined) };
  const deny = Array.isArray(permissions.deny) ? [...(permissions.deny as string[])] : [];
  for (const rule of SECRET_DENY_RULES) if (!deny.includes(rule)) deny.push(rule);
  permissions.deny = deny;
  next.permissions = permissions;
  return next;
}

/** The exact settings fragment to add by hand when we can't safely edit settings.json. */
export const MANUAL_AGENT_SNIPPET = JSON.stringify(mergeAgentSettings({}), null, 2);

export interface HookInstall {
  /** Path to the written hook script (always created — it lives in our `.sandbox/` dir). */
  script: string;
  /** Path to the project settings file. */
  settings: string;
  /**
   * `true` when the hook + deny rules are wired into settings.json. `false` when an existing
   * settings.json couldn't be parsed (or wasn't a JSON object) and was left untouched to avoid
   * data loss — the caller surfaces {@link MANUAL_AGENT_SNIPPET} so the user merges it by hand.
   */
  wired: boolean;
}

/**
 * Install the host-side enforcement hook into the repo: write the self-contained script and
 * merge it into `.claude/settings.json`.
 *
 * Data safety: an existing settings.json is only rewritten after it parses to a JSON object.
 * If it's malformed (a trailing comma, a non-object, anything `JSON.parse` rejects), the file
 * is left exactly as-is and `wired: false` is returned — never overwrite settings we can't
 * read, or a single bad character would destroy the user's Claude configuration. The caller
 * surfaces {@link MANUAL_AGENT_SNIPPET} so the user can wire it by hand after fixing the file.
 */
export function installAgentHook(cwd: string): HookInstall {
  const scriptPath = path.join(cwd, HOOK_REL);
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, HOOK_SCRIPT, { mode: 0o755 });

  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });

  if (existsSync(settingsPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(readFileSync(settingsPath, 'utf8')));
    } catch {
      return { script: scriptPath, settings: settingsPath, wired: false }; // unparseable — preserve it
    }
    if (!isPlainObject(parsed)) {
      return { script: scriptPath, settings: settingsPath, wired: false }; // not a settings object — preserve it
    }
    writeFileSync(settingsPath, `${JSON.stringify(mergeAgentSettings(parsed), null, 2)}\n`);
    return { script: scriptPath, settings: settingsPath, wired: true };
  }

  writeFileSync(settingsPath, `${JSON.stringify(mergeAgentSettings({}), null, 2)}\n`);
  return { script: scriptPath, settings: settingsPath, wired: true };
}
