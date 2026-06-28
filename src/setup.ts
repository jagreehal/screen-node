import { existsSync } from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.js';
import { mergeDetectedEgress, printInitSummary, writeAgentArtifacts, writeSandboxConfig } from './init.js';
import { projectModeLabel } from './mode.js';
import { detectProjectMode } from './native-deps.js';
import { resolvePackageManager } from './package-manager.js';
import { PRESET_NAMES, presetConfig, type PresetName } from './presets.js';

export interface SetupOptions {
  preset?: string;
  force?: boolean;
}

export async function runSetup(cwd: string, opts: SetupOptions): Promise<number> {
  const configPath = path.join(cwd, 'sandbox.config.json');
  const preset = (opts.preset ?? 'balanced') as PresetName;
  if (!PRESET_NAMES.includes(preset)) {
    console.error(`sandbox: unknown preset '${opts.preset}' (use: ${PRESET_NAMES.join(' | ')})`);
    return 1;
  }

  let config = readConfig(cwd);
  if (!existsSync(configPath) || opts.force) {
    const fresh = presetConfig(preset);
    const addedHosts = mergeDetectedEgress(cwd, fresh);
    const configFile = writeSandboxConfig(cwd, fresh);
    const agent = preset === 'agent' ? writeAgentArtifacts(cwd) : undefined;
    printInitSummary(preset, configFile, resolvePackageManager(cwd), agent, addedHosts);
    config = readConfig(cwd);
  } else {
    console.log(`sandbox: using existing ${path.basename(configPath)}`);
    if (preset === 'agent') {
      const { agentFile } = writeAgentArtifacts(cwd);
      console.log(`sandbox: wrote ${path.relative(cwd, agentFile)} (paste into your agent's project instructions)`);
    }
  }

  const secrets = config.grants['ssh-agent'] || config.grants.claude !== 'none' || config.grants.paths.length || config.grants.env.length || config.grants.envFiles.length
    ? 'custom grants configured'
    : 'blocked (~/.ssh, ~/.npmrc, ~/.aws, home)';
  console.log('');
  console.log(`sandbox: ${preset} preset`);
  console.log(`secrets: ${secrets}`);
  const pm = resolvePackageManager(cwd);
  console.log(projectModeLabel(detectProjectMode(cwd)));
  console.log('');
  console.log('Next:');
  console.log('  screen check zod          review a package before you add it (installs nothing)');
  console.log('  screen install            vet, then install natively with the detected package manager');

  printBinsTip(pm);
  return 0;
}

/**
 * Point at the per-PM binaries: same keystrokes as your package manager, gated first, then a native
 * install. Your real `npm`/`pnpm` is never shadowed. No shell editing, no takeover.
 */
function printBinsTip(pm: ReturnType<typeof resolvePackageManager>): void {
  console.log('');
  console.log('Advanced:');
  console.log(`  s${pm} add zod              same gated native path, shorter keystrokes (your real ${pm} stays untouched)`);
}
