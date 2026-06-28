import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { LOCAL_CONFIG_NAME, writeConfig, type SandboxConfig } from './config.js';
import { projectModeLabel } from './mode.js';
import { resolvePackageManager, type PackageManager } from './package-manager.js';
import { PRESETS, PRESET_NAMES, presetConfig, type PresetName } from './presets.js';
import { detectEgressHosts, missingAllowHosts } from './registry.js';
import { HOST_GROUPS, hostGroup } from './host-groups.js';

/**
 * Merge hosts an install will likely need (private registry from `.npmrc`, github for git deps)
 * into the config's `egress.allow` so first run doesn't fail on a blocked host. Mutates `config`,
 * returns the hosts added (for the summary). Empty when nothing new is detected.
 */
export function mergeDetectedEgress(cwd: string, config: SandboxConfig): string[] {
  const added = missingAllowHosts(config.egress.allow, detectEgressHosts(cwd));
  if (added.length) config.egress.allow = [...config.egress.allow, ...added].sort();
  return added;
}

/**
 * Add the hosts from the named opt-in {@link HOST_GROUPS} to `egress.allow`. Mutates `config`,
 * returns the hosts actually added (deduped against what's already allowed) for the summary.
 */
export function applyHostGroups(config: SandboxConfig, groupNames: string[]): string[] {
  const hosts = groupNames.flatMap((name) => hostGroup(name)?.hosts ?? []);
  const added = missingAllowHosts(config.egress.allow, hosts);
  if (added.length) config.egress.allow = [...config.egress.allow, ...added].sort();
  return added;
}

export interface InitOptions {
  /** Non-interactive: write this preset directly (for CI / scripts). */
  preset?: string;
  force?: boolean;
}

const AGENT_DIR = '.screen';
const AGENT_FILE = 'AGENT.md';
const AGENT_BODY = `When working in this repo:

- Use \`screen install\`, not \`npm install\`
- Use \`screen add <pkg>\`, not \`npm install <pkg>\`
- Use \`screen update\`, not \`npm update\`
- Use \`screen dev\`, not \`npm run dev\`
- Use \`screen test\`, not \`npm test\`
- Use \`screen script build\` when a script name collides with a screen command
- Do not ask for host credentials unless the user explicitly approves a grant
`;

/** Write a config object (with a `$schema` ref for editor autocomplete) to cwd. */
export function writeSandboxConfig(cwd: string, config: SandboxConfig): string {
  const file = path.join(cwd, 'screen.config.json');
  const written = writeConfig(file, config);
  ensureLocalConfigIgnored(cwd); // the personal override is meant to stay out of git
  return written;
}

/**
 * Keep `screen.config.local.json` (the personal, loosen-loudly override) out of version
 * control, so committing it can't silently widen the boundary for the whole team. Idempotent;
 * creates `.gitignore` if absent. Returns true when it changed the file.
 */
export function ensureLocalConfigIgnored(cwd: string): boolean {
  const file = path.join(cwd, '.gitignore');
  const body = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (body.split(/\r?\n/).some((line) => line.trim() === LOCAL_CONFIG_NAME)) return false;
  const sep = body === '' || body.endsWith('\n') ? '' : '\n';
  writeFileSync(file, `${body}${sep}# personal screen overrides, do not commit\n${LOCAL_CONFIG_NAME}\n`);
  return true;
}

export function writeAgentInstructions(cwd: string): string {
  const dir = path.join(cwd, AGENT_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, AGENT_FILE);
  writeFileSync(file, AGENT_BODY);
  return file;
}

export interface AgentArtifacts {
  agentFile: string;
}

/**
 * The agent preset's repo-local setup: the advisory `AGENT.md` that tells the agent to route
 * installs through `screen` so the gate engine vets every dependency before it lands.
 */
export function writeAgentArtifacts(cwd: string): AgentArtifacts {
  return { agentFile: writeAgentInstructions(cwd) };
}

export function initNextCommands(preset: PresetName): string[] {
  return preset === 'vibe' || preset === 'agent' || preset === 'trusted'
    ? ['screen check zod', 'screen install', 'screen dev']
    : ['screen check zod', 'screen install', 'screen test'];
}

/** Post-init tips, one string per tip. The first two apply to every preset; agent adds one. */
export function initTips(preset: PresetName, pm: PackageManager): string[] {
  const tips = [
    `advanced: s${pm} add zod uses the same mode-aware path (native, or contained if the tree already is) with shorter keystrokes; your real ${pm} stays untouched`,
  ];
  return tips;
}

export function printInitSummary(preset: PresetName, configFile: string, pm: PackageManager, agent?: AgentArtifacts, addedHosts: string[] = []): void {
  const rel = (f: string) => path.relative(path.dirname(configFile), f);
  console.log(`screen: wrote ${path.basename(configFile)} using the ${preset} preset`);
  if (addedHosts.length) {
    console.log(`screen: added ${addedHosts.join(', ')} to egress.allow (detected from .npmrc / git deps)`);
  }
  if (agent) {
    console.log(`screen: wrote ${rel(agent.agentFile)} (paste into Claude/Cursor/Codex project instructions)`);
  }
  console.log('');
  console.log(projectModeLabel('no-deps'));
  console.log('Next:');
  for (const command of initNextCommands(preset)) console.log(`  ${command}`);
  for (const tip of initTips(preset, pm)) {
    console.log('');
    console.log(`Tip: ${tip}`);
  }
}

/**
 * Create a `screen.config.json` from a preset. With `--preset` it's non-interactive;
 * otherwise it walks an interactive picker (requires a TTY).
 */
export async function runInit(cwd: string, opts: InitOptions = {}): Promise<number> {
  const file = path.join(cwd, 'screen.config.json');

  // Non-interactive path.
  if (opts.preset) {
    if (!PRESET_NAMES.includes(opts.preset as PresetName)) {
      console.error(`screen: unknown preset '${opts.preset}' (use: ${PRESET_NAMES.join(' | ')})`);
      return 1;
    }
    if (existsSync(file) && !opts.force) {
      console.error(`screen: ${file} already exists (pass --force to overwrite)`);
      return 1;
    }
    const preset = opts.preset as PresetName;
    const config = presetConfig(preset);
    const addedHosts = mergeDetectedEgress(cwd, config);
    const configFile = writeSandboxConfig(cwd, config);
    const agent = preset === 'agent' ? writeAgentArtifacts(cwd) : undefined;
    printInitSummary(preset, configFile, resolvePackageManager(cwd), agent, addedHosts);
    return 0;
  }

  // No TTY and no explicit --preset: rather than dead-end with an error, write the safe
  // middle preset and say so. The user (or agent) can re-run with --preset to choose, or
  // --force to overwrite. Keeps `sandbox init` from failing in CI / agent shells.
  if (!process.stdout.isTTY) {
    const fallback: PresetName = 'balanced';
    console.log(`screen: no TTY and no --preset given, using the '${fallback}' preset (safe default).`);
    console.log(`screen: re-run with --preset ${PRESET_NAMES.join('|')} to choose a different one.`);
    return runInit(cwd, { ...opts, preset: fallback });
  }

  p.intro('screen-node init');

  if (existsSync(file) && !opts.force) {
    const ok = await p.confirm({ message: 'screen.config.json exists. Overwrite?', initialValue: false });
    if (p.isCancel(ok) || !ok) {
      p.cancel('Kept existing config.');
      return 1;
    }
  }

  const preset = await p.select({
    message: 'Security preset',
    options: Object.values(PRESETS).map((x) => ({ value: x.name, label: x.label, hint: x.hint })),
    initialValue: 'balanced' as PresetName,
  });
  if (p.isCancel(preset)) return cancel();

  const config = presetConfig(preset);

  const sshAgent = await p.confirm({
    message: 'Forward your SSH agent? (git inside the container; key bytes stay out)',
    initialValue: config.grants['ssh-agent'],
  });
  if (p.isCancel(sshAgent)) return cancel();
  config.grants['ssh-agent'] = sshAgent;

  const claude = await p.select({
    message: 'Claude config inside the container?',
    options: [
      { value: 'none', label: 'None' },
      { value: 'project', label: 'Project (./.claude-screen)' },
      { value: 'home', label: 'Home (~/.claude), leaky' },
    ],
    initialValue: config.grants.claude,
  });
  if (p.isCancel(claude)) return cancel();
  config.grants.claude = claude;

  // Opt-in egress bundles. Default-deny stays the default — nothing is preselected; the user
  // deliberately widens to a curated, labelled group (or none) instead of allowing hosts blind.
  const groups = await p.multiselect({
    message: 'Pre-allow any common egress bundles? (default-deny otherwise, you can always add more later)',
    options: HOST_GROUPS.map((g) => ({ value: g.name, label: g.label, hint: g.why })),
    required: false,
    initialValues: [] as string[],
  });
  if (p.isCancel(groups)) return cancel();
  const groupHosts = applyHostGroups(config, groups);

  const addedHosts = mergeDetectedEgress(cwd, config);
  const configFile = writeSandboxConfig(cwd, config);
  const agent = preset === 'agent' ? writeAgentArtifacts(cwd) : undefined;
  p.outro(`Wrote screen.config.json (${preset})`);
  printInitSummary(preset, configFile, resolvePackageManager(cwd), agent, addedHosts);
  if (groupHosts.length) console.log(`screen: added ${groups.join(', ')} group(s) to egress.allow: ${groupHosts.join(', ')}`);
  return 0;
}

function cancel(): number {
  p.cancel('Aborted.');
  return 1;
}
