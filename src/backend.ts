import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuildReporter, type BuildReporter } from './build-progress.js';
import { withEgress, type EgressHandle } from './egress.js';
import { capture, quiet, run, type CaptureResult } from './exec.js';
import { classifyImageState, customDockerfileWarnings, derivedDockerfile, extraStepsNeedRepoContext, hasExtraLayer, isCustomBuild, specFingerprint, SPEC_LABEL, type BuildSpec, type ImageState } from './image.js';
import { log } from './log.js';
import type { RunPlan } from './plan.js';

const PROXY_IMAGE = 'node-install-sandbox-proxy:latest';

/** Adjustments `execute` applies at run time (the egress mechanism, host-port availability). */
export interface RunOverride {
  /** Explicit `--network` value; omit for the default bridge. */
  network?: string;
  extraEnv?: Record<string, string>;
  /** Ports to actually publish, after probing host availability; falls back to `plan.ports`. */
  ports?: string[];
}

/** A container runtime (docker or podman — their CLIs are arg-compatible here). */
export interface ContainerBackend {
  readonly bin: string;
  ensureImage(spec: BuildSpec): Promise<void>;
  buildImages(spec: BuildSpec): Promise<number>;
  /** Run the plan with inherited stdio (the interactive/CLI path); resolves with the exit code. */
  runPlan(plan: RunPlan, override?: RunOverride): Promise<number>;
  /** Run the plan capturing stdout/stderr (the embedded/programmatic path, e.g. {@link runCode}). */
  runPlanCaptured(plan: RunPlan, override?: RunOverride): Promise<CaptureResult>;
  withEgress<T>(allow: string[], fn: (handle: EgressHandle) => Promise<T>, onDenials?: (hosts: string[]) => void, onLog?: (logText: string) => void): Promise<T>;
}

/** Locate the package root (holds Dockerfile + proxy/) from this module. */
function assetsRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'Dockerfile'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('sandbox: cannot locate Dockerfile (package assets missing)');
}

/** Entry point (in the image) that blackholes cloud metadata then drops all caps. */
const METADATA_GUARD = '/usr/local/bin/sbx-net-guard';

/** Render a RunPlan (+ runtime override) into `<bin> run ...` argv. Pure & testable. */
export function renderRunArgs(plan: RunPlan, override: RunOverride = {}): string[] {
  // Bridge mode ("on"/full-network): no explicit network, so the container has a route to the
  // host's link-local cloud-metadata endpoint (169.254.169.254). Hand the init just
  // CAP_NET_ADMIN + CAP_SETPCAP so it can blackhole that endpoint and then drop every
  // capability before your command runs — install/dev code can't reach IMDS or undo
  // the block. Isolated ('none') and allowlist-proxy modes have no such route.
  const bridge = override.network === undefined;
  const args = ['run', '--rm'];
  if (plan.interactive) args.push(process.stdin.isTTY && process.stdout.isTTY ? '-it' : '-i');
  for (const cap of plan.capDrop) args.push('--cap-drop', cap);
  if (bridge) args.push('--cap-add', 'NET_ADMIN', '--cap-add', 'SETPCAP');
  for (const opt of plan.securityOpt) args.push('--security-opt', opt);
  args.push('-w', plan.workdir);
  const env = { ...plan.env, ...override.extraEnv };
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  for (const m of plan.mounts) {
    if (m.type === 'volume') {
      const source = m.source ? `source=${m.source},` : '';
      args.push('--mount', `type=volume,${source}target=${m.target}${m.readonly ? ',readonly' : ''}`);
    } else {
      // `--mount` (not `-v`): its key=value parsing never splits on `:`, so a Windows host path
      // like `C:\Users\x` mounts correctly instead of being mangled by the `-v src:target` colon.
      args.push('--mount', `type=bind,source=${m.source},target=${m.target}${m.readonly ? ',readonly' : ''}`);
    }
  }
  for (const p of override.ports ?? plan.ports) args.push('-p', p);
  for (const h of plan.addHosts) args.push('--add-host', h);
  if (override.network) args.push('--network', override.network);
  if (bridge) args.push('--entrypoint', METADATA_GUARD);
  args.push(plan.image, ...plan.argv);
  return args;
}

/**
 * Build the sandbox image for a {@link BuildSpec}. Three paths, in order of trust:
 *
 *  - `customDockerfileUnsafe`: build the user's file verbatim. The bundled security layers
 *    are NOT applied; warn loudly and flag any guard the file dropped.
 *  - extras present: build the security base (bundled Dockerfile + `NODE_BASE`), then a thin
 *    derived layer (`FROM base` + extra packages/steps). Extras can only ADD to the boundary.
 *  - otherwise: a single build of the bundled Dockerfile with the resolved base image.
 */
async function buildSandbox(bin: string, spec: BuildSpec): Promise<number> {
  const root = assetsRoot();
  // The final image carries the spec fingerprint as a label so ensure/setup can rebuild it when
  // the resolved spec changes (intermediate `-base` images are unlabelled — they're rebuilt by
  // the derived build anyway).
  const label = ['--label', `${SPEC_LABEL}=${specFingerprint(spec)}`];
  if (spec.customDockerfile) {
    if (!existsSync(spec.customDockerfile)) throw new Error(`sandbox: build.customDockerfileUnsafe not found: ${spec.customDockerfile}`);
    log.warn(`build.customDockerfileUnsafe, bundled security layers are NOT applied; you own the boundary (${spec.customDockerfile})`);
    for (const warning of customDockerfileWarnings(readFileSync(spec.customDockerfile, 'utf8'))) log.warn(warning);
    return run(bin, ['build', '-t', spec.tag, ...label, '-f', spec.customDockerfile, dirname(spec.customDockerfile)]);
  }
  const baseArgs = ['build', '--build-arg', `NODE_BASE=${spec.baseImage}`];
  if (!hasExtraLayer(spec)) return run(bin, [...baseArgs, ...label, '-t', spec.tag, root]);
  const baseTag = `${spec.tag}-base`;
  const baseCode = await run(bin, [...baseArgs, '-t', baseTag, root]);
  if (baseCode !== 0) return baseCode;
  // The generated Dockerfile lives in a temp dir (referenced via -f). The build CONTEXT is the
  // project root ONLY when an extra step COPY/ADDs from it (honour .dockerignore there); otherwise
  // it's the temp dir, so a RUN/ENV/extraPackages-only build doesn't ship the whole repo.
  const dir = mkdtempSync(join(tmpdir(), 'sbx-build-'));
  const dockerfile = join(dir, 'Dockerfile');
  writeFileSync(dockerfile, derivedDockerfile(baseTag, spec));
  const context = extraStepsNeedRepoContext(spec.extraSteps) ? spec.buildContext : dir;
  return run(bin, ['build', '-t', spec.tag, ...label, '-f', dockerfile, context]);
}

/**
 * Inspect the image for {@link spec.tag} and report whether it's `absent`, `stale` (built from a
 * different spec), or `current`. Drives both the rebuild decision and the first-run build messaging.
 */
export async function imageBuildState(bin: string, spec: BuildSpec): Promise<ImageState> {
  const { code, stdout } = await capture(bin, ['image', 'inspect', spec.tag, '--format', `{{ index .Config.Labels "${SPEC_LABEL}" }}`]);
  return classifyImageState({ code, label: stdout }, specFingerprint(spec));
}

/**
 * True when an image for {@link spec.tag} already exists AND was built from this exact spec
 * (its {@link SPEC_LABEL} matches the current fingerprint). A missing image, or one built from a
 * different base/extras/custom Dockerfile, returns false so callers rebuild instead of running stale.
 */
export async function sandboxImageUpToDate(bin: string, spec: BuildSpec): Promise<boolean> {
  return (await imageBuildState(bin, spec)) === 'current';
}

export interface BackendOptions {
  /** Surfaces the one-time image build (CLI passes a spinner; library/CI gets plain stderr lines). */
  buildReporter?: BuildReporter;
}

export function createBackend(bin: 'docker' | 'podman' = 'docker', backendOpts: BackendOptions = {}): ContainerBackend {
  const buildReporter = backendOpts.buildReporter ?? createBuildReporter();
  const ensureSimple = async (tag: string, contextDir: string) => {
    if ((await quiet(bin, ['image', 'inspect', tag])) === 0) return;
    log.info('building image', { tag });
    const code = await run(bin, ['build', '-t', tag, contextDir]);
    if (code !== 0) throw new Error(`sandbox: failed to build ${tag}`);
  };

  return {
    bin,
    ensureImage: async (spec) => {
      const state = await imageBuildState(bin, spec);
      if (state === 'current') return;
      log.debug('building image', { tag: spec.tag, base: spec.baseImage, custom: isCustomBuild(spec), state });
      buildReporter.start(state);
      const code = await buildSandbox(bin, spec);
      if (code !== 0) {
        buildReporter.fail();
        throw new Error(`sandbox: failed to build ${spec.tag}`);
      }
      buildReporter.succeed();
    },
    buildImages: async (spec) => {
      const code = await buildSandbox(bin, spec);
      if (code !== 0) return code;
      return run(bin, ['build', '-t', PROXY_IMAGE, join(assetsRoot(), 'proxy')]);
    },
    runPlan: (plan, override) => run(bin, renderRunArgs(plan, override)),
    runPlanCaptured: (plan, override) => capture(bin, renderRunArgs(plan, override)),
    withEgress: async (allow, fn, onDenials, onLog) => {
      await ensureSimple(PROXY_IMAGE, join(assetsRoot(), 'proxy'));
      return withEgress(bin, PROXY_IMAGE, allow, fn, onDenials, onLog);
    },
  };
}
