import { existsSync } from 'node:fs';
import path from 'node:path';
import { createBackend, sandboxImageUpToDate } from './backend.js';
import { readConfig } from './config.js';
import { capture } from './exec.js';
import { resolveBuildSpec } from './image.js';
import { mergeDetectedEgress, printInitSummary, printUnwiredHookWarning, writeAgentArtifacts, writeSandboxConfig } from './init.js';
import { projectModeLabel } from './mode.js';
import { detectProjectMode } from './native-deps.js';
import { resolvePackageManager } from './package-manager.js';
import { PRESET_NAMES, presetConfig, type PresetName } from './presets.js';

export interface SetupOptions {
  preset?: string;
  force?: boolean;
  backend: 'docker' | 'podman';
  image?: string;
}

export function backendInstallHint(backend: 'docker' | 'podman'): string {
  if (process.platform === 'darwin') return backend === 'docker' ? 'brew install --cask docker' : 'brew install podman';
  return backend === 'docker' ? 'install Docker and ensure `docker` is on PATH' : 'install Podman and ensure `podman` is on PATH';
}

export function backendStartHint(backend: 'docker' | 'podman'): string {
  if (process.platform === 'darwin') return backend === 'docker' ? 'open -a Docker' : 'podman machine start';
  return backend === 'docker' ? 'sudo systemctl start docker' : 'start the Podman service or machine for this host';
}

/**
 * Friendly guidance when a contained run fails because the runtime is missing or its daemon is down —
 * the same install/start hints `setup` and `doctor` give. `probe` is the result of the cheap checks
 * the CLI runs only on the failure path. Returns the problem line first, then the fixes, or undefined
 * when the backend looks healthy (so an unrelated error surfaces unchanged). Pure → testable.
 */
export function backendDownGuidance(probe: { installed: boolean; daemonUp: boolean }, backend: 'docker' | 'podman'): string[] | undefined {
  const rerun = 'then re-run, or check your setup with:  sandbox doctor';
  if (!probe.installed) return [`${backend} isn't installed (or not on your PATH), that's why this couldn't run`, `install it:  ${backendInstallHint(backend)}`, rerun];
  if (!probe.daemonUp) return [`the ${backend} daemon isn't running, that's why this couldn't run`, `start it:  ${backendStartHint(backend)}`, rerun];
  return undefined;
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
      const { agentFile, hook } = writeAgentArtifacts(cwd);
      console.log(`sandbox: wrote ${path.relative(cwd, agentFile)} (paste into your agent's project instructions)`);
      console.log(`sandbox: wrote ${path.relative(cwd, hook.script)}`);
      if (hook.wired) {
        console.log(`sandbox: wired ${path.relative(cwd, hook.settings)}, a PreToolUse hook blocks bare npm/pnpm/yarn/bun/npx, and .env/secrets are denied to the agent`);
      } else {
        printUnwiredHookWarning(path.relative(cwd, hook.settings));
      }
    }
  }

  const version = await capture(opts.backend, ['--version']);
  if (version.code !== 0) {
    console.log(`sandbox: backend check failed: ${version.stderr.trim() || version.stdout.trim() || `${opts.backend} not found`}`);
    console.log(`sandbox: install it with: ${backendInstallHint(opts.backend)}`);
    return 1;
  }
  console.log(`sandbox: backend ready: ${(version.stdout.trim() || version.stderr.trim()).trim()}`);

  const info = await capture(opts.backend, ['info']);
  if (info.code !== 0) {
    console.log(`sandbox: backend daemon is not reachable: ${info.stderr.trim() || info.stdout.trim() || `${opts.backend} info failed`}`);
    console.log(`sandbox: start it with: ${backendStartHint(opts.backend)}`);
    return 1;
  }

  const image = opts.image ?? config.image;
  const spec = resolveBuildSpec(config, image, cwd);
  if (!(await sandboxImageUpToDate(opts.backend, spec))) {
    console.log(`sandbox: building ${image} and the egress proxy image`);
    const code = await createBackend(opts.backend).buildImages(spec);
    if (code !== 0) return code;
    console.log('sandbox: images are ready');
  } else {
    console.log(`sandbox: image ready: ${image}`);
  }

  const secrets = config.grants['ssh-agent'] || config.grants.claude !== 'none' || config.grants.paths.length || config.grants.env.length || config.grants.envFiles.length
    ? 'custom grants configured'
    : 'blocked (~/.ssh, ~/.npmrc, ~/.aws, home)';
  console.log('');
  console.log(`sandbox: ${preset} preset`);
  console.log(`network: ${config.run.network}${config.run.devPorts ? ' for dev server' : ''}`);
  if (config.run.devPorts) console.log('ports: common dev ports -> localhost');
  console.log(`secrets: ${secrets}`);
  const pm = resolvePackageManager(cwd);
  console.log(projectModeLabel(detectProjectMode(cwd)));
  console.log('');
  console.log('Next:');
  console.log('  sandbox check zod          review a package before you add it (no container, installs nothing)');
  console.log('  sandbox install            vet, then install (native, or contained if the tree already is) with the detected package manager');
  console.log(`  sandbox ${preset === 'vibe' || preset === 'agent' || preset === 'trusted' ? 'dev' : 'test'}                ${preset === 'vibe' || preset === 'agent' || preset === 'trusted' ? 'run your app in the container' : 'run your project tests in the container'}`);

  printBinsTip(pm);
  return 0;
}

/**
 * Point at the per-PM binaries: same keystrokes as your package manager, gated first, then a
 * mode-aware install (native on a host-native or fresh project, contained when the tree already is).
 * The explicit `sandbox <pm>` form remains the one-keystroke force-container path. Your real
 * `npm`/`pnpm` is never shadowed. No shell editing, no takeover.
 */
function printBinsTip(pm: ReturnType<typeof resolvePackageManager>): void {
  console.log('');
  console.log('Advanced:');
  console.log(`  s${pm} add zod              same mode-aware path, shorter keystrokes (your real ${pm} stays untouched)`);
  console.log('  sandbox devcontainer init  keep your editor + agent inside the container for the full session');
}
