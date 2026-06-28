import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxConfig } from './config.js';
import { parsePackageManagerField } from './package-manager.js';

/**
 * The base image the bundled Dockerfile builds `FROM` when nothing overrides it.
 * Kept in sync with the `ARG NODE_BASE=` default in the Dockerfile — the build-arg
 * is what actually swaps it, this constant is how the rest of the code recognises
 * "the user customised the base" (so it can warn / rebuild / annotate).
 */
export const DEFAULT_BASE_IMAGE = 'node:24-bookworm-slim';

/** Repo name for the built-in managed image (the part before the tag). */
export const MANAGED_IMAGE_REPO = 'node-install-sandbox';
/**
 * The built-in default `config.image`. When this is the requested image we derive a
 * per-fingerprint tag (see {@link resolveBuildSpec}); any other image name is honoured verbatim
 * because the user chose it. Kept in sync with the default in `config.ts`.
 */
export const MANAGED_IMAGE = `${MANAGED_IMAGE_REPO}:latest`;

/** Markers a full-replacement Dockerfile must keep, or the boundary it promises is hollow. */
const REQUIRED_MARKERS: { needle: string; missing: string }[] = [
  { needle: 'sbx-net-guard', missing: "the metadata guard (sbx-net-guard), 'on'/full-network mode will NOT blackhole cloud metadata (169.254.169.254)" },
  { needle: 'libcap2-bin', missing: 'libcap2-bin, the guard cannot drop Linux capabilities before your command runs' },
  { needle: 'corepack', missing: 'corepack, pnpm/yarn will try to download at run time and fail under the no-network/allowlist phases' },
];

/**
 * Everything `backend` needs to build the sandbox image for one invocation. Derived
 * from `config.build` so the build path stays a pure function of config (testable),
 * and so {@link isCustomBuild} can tell the default fast-path from a customised one.
 */
export interface BuildSpec {
  /** Final image tag the run will use. */
  tag: string;
  /** Resolved `FROM` for the bundled Dockerfile (passed as the `NODE_BASE` build-arg). */
  baseImage: string;
  /** Extra apt packages layered on top of the security base. */
  extraPackages: string[];
  /** Raw Dockerfile instructions (RUN/ENV/COPY…) layered on top of the security base. */
  extraSteps: string[];
  /**
   * Docker build context for the extra-steps layer — the project root. `COPY`/`ADD` paths in
   * {@link extraSteps} resolve against this, so they can pull files from your repo into the image.
   */
  buildContext: string;
  /** Absolute path to a user-supplied Dockerfile that fully replaces the bundled one. */
  customDockerfile?: string;
}

/** `baseImage` wins; else derive from `nodeVersion`; else the bundled default. */
export function resolveBaseImage(build: SandboxConfig['build']): string {
  if (build.baseImage) return build.baseImage;
  if (build.nodeVersion) return `node:${build.nodeVersion}-bookworm-slim`;
  return DEFAULT_BASE_IMAGE;
}

/**
 * pnpm/yarn versions baked into the bundled image (see the `corepack prepare` line in
 * the Dockerfile). A project pinning one of these needs no extra build step.
 */
export const BAKED_COREPACK: Record<string, string> = { pnpm: '9.15.0', yarn: '1.22.22' };
/** Modern Yarn cached in the image for `yarn dlx` when a repo hasn't pinned Yarn Berry yet. */
export const BAKED_YARN_DLX = '4.14.1';

/**
 * The `corepack prepare` step for a project's pinned `packageManager`, so the exact
 * pnpm/yarn version is baked at build time (where the network is available) instead of
 * corepack trying — and failing — to download it at run time behind the egress proxy or
 * in a no-network phase. Passes the raw field (integrity hash included) so corepack
 * verifies it. Returns null for no pin, npm/bun, or a version already baked into the image.
 */
export function corepackPrepareStep(packageManagerField: unknown): string | null {
  const parsed = parsePackageManagerField(packageManagerField);
  if (!parsed || (parsed.name !== 'pnpm' && parsed.name !== 'yarn')) return null;
  if (BAKED_COREPACK[parsed.name] === parsed.version) return null;
  return `RUN ${JSON.stringify(['corepack', 'prepare', parsed.raw, '--activate'])}`;
}

/** The `packageManager` field from `<dir>/package.json`, or undefined if unreadable. */
function readPackageManagerField(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).packageManager;
  } catch {
    return undefined;
  }
}

/**
 * Turn `config.build` + the resolved image tag into a {@link BuildSpec}. `contextDir` is the
 * project root — the build context for `COPY`/`ADD` in `extraSteps`, and the source of the
 * project's pinned package manager (baked via a leading `corepack prepare` step).
 */
export function resolveBuildSpec(config: SandboxConfig, tag: string, contextDir: string): BuildSpec {
  const b = config.build;
  const pmStep = corepackPrepareStep(readPackageManagerField(contextDir));
  const spec: BuildSpec = {
    tag,
    baseImage: resolveBaseImage(b),
    extraPackages: b.extraPackages,
    // Bake the project's pinned pnpm/yarn first, then the user's own extra steps.
    extraSteps: pmStep ? [pmStep, ...b.extraSteps] : b.extraSteps,
    buildContext: contextDir,
    customDockerfile: b.customDockerfileUnsafe ? path.resolve(b.customDockerfileUnsafe) : undefined,
  };
  // For the built-in managed image, derive a per-fingerprint tag so projects with different package
  // managers / build configs each get their OWN cached image — instead of every project sharing one
  // `:latest` that gets rebuilt and re-tagged on each switch. That churn used to flip the baked pnpm
  // version between projects, which then made a project's existing node_modules look foreign and
  // triggered a (no-TTY-fatal) reinstall purge. A stable per-fingerprint tag removes the flip
  // entirely. Custom/explicit images are honoured verbatim — the user named that image on purpose.
  if (tag === MANAGED_IMAGE) {
    spec.tag = `${MANAGED_IMAGE_REPO}:${specFingerprint(spec)}`;
  }
  return spec;
}

/** Image label that records which build spec produced an image (drives rebuild-on-change). */
export const SPEC_LABEL = 'dev.sandbox-node.spec';

function bundledImageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'Dockerfile'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('sandbox: cannot locate bundled Dockerfile for fingerprinting');
}

/**
 * The managed image depends on the bundled Dockerfile plus the helper files it COPYs into the
 * image. Fold those contents into the fingerprint so a local code change rebuilds the image even
 * when the user-facing config did not change.
 */
export function bundledImageMaterial(root: string = bundledImageRoot()): string {
  return JSON.stringify({
    dockerfile: readFileSync(path.join(root, 'Dockerfile'), 'utf8'),
    netGuard: readFileSync(path.join(root, 'net-guard.sh'), 'utf8'),
  });
}

/**
 * Stable fingerprint of everything that affects the built image: base, extra packages/steps, the
 * bundled managed-image recipe, and — for the custom path — the Dockerfile's path AND its current
 * contents. Stamped onto the image as {@link SPEC_LABEL} so a config or recipe change forces a
 * rebuild instead of silently reusing a stale tag.
 */
export function specFingerprint(spec: BuildSpec): string {
  const custom = spec.customDockerfile;
  const material = JSON.stringify({
    base: spec.baseImage,
    pkgs: spec.extraPackages,
    steps: spec.extraSteps,
    bundled: custom ? null : bundledImageMaterial(),
    custom: custom ?? null,
    customContent: custom && existsSync(custom) ? readFileSync(custom, 'utf8') : null,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Whether a built image still matches its spec. `absent`: no image for the tag. `stale`: an image
 * exists but was built from a different spec (its {@link SPEC_LABEL} fingerprint differs) so a run
 * will rebuild it. `current`: present and up to date. Pure — the docker `image inspect` call lives
 * in the backend; this just interprets its (exit code, label) result against the expected fingerprint.
 */
export type ImageState = 'absent' | 'stale' | 'current';

export function classifyImageState(inspect: { code: number; label: string }, expectedFingerprint: string): ImageState {
  if (inspect.code !== 0) return 'absent';
  return inspect.label.trim() === expectedFingerprint ? 'current' : 'stale';
}

/** True when the spec departs from the bundled default in any way (drives rebuilds + banners). */
export function isCustomBuild(spec: BuildSpec): boolean {
  return (
    spec.baseImage !== DEFAULT_BASE_IMAGE ||
    spec.extraPackages.length > 0 ||
    spec.extraSteps.length > 0 ||
    spec.customDockerfile !== undefined
  );
}

/** True when extras must be layered on top of the built security base (vs a single build). */
export function hasExtraLayer(spec: BuildSpec): boolean {
  return spec.extraPackages.length > 0 || spec.extraSteps.length > 0;
}

/**
 * True when any extra step is a `COPY`/`ADD`, so the derived build needs the project root as its
 * context. Without one, the build uses a throwaway temp context instead of shipping the whole repo
 * (incl. node_modules) to the daemon — the fast path for `extraPackages`-only or `RUN`/`ENV` extras.
 */
export function extraStepsNeedRepoContext(extraSteps: string[]): boolean {
  return extraSteps.some((step) => /^\s*(COPY|ADD)\b/i.test(step));
}

/**
 * The thin Dockerfile that layers a user's extras ON TOP of the already-built security
 * base (`baseTag`). Because the security layers are baked into `baseTag`, extras can only
 * add — they can't quietly drop the metadata guard or the capability tooling.
 */
export function derivedDockerfile(baseTag: string, spec: BuildSpec): string {
  const lines = [`FROM ${baseTag}`];
  if (spec.extraPackages.length) {
    lines.push(
      '# build.extraPackages',
      `RUN apt-get update && apt-get install -y --no-install-recommends \\`,
      `      ${spec.extraPackages.join(' ')} \\`,
      '  && rm -rf /var/lib/apt/lists/*',
    );
  }
  if (spec.extraSteps.length) {
    lines.push('# build.extraSteps', ...spec.extraSteps);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Scan a full-replacement Dockerfile for the security layers the sandbox relies on.
 * Anything missing is returned as a loud warning — the run still proceeds (the user
 * opted in via `customDockerfileUnsafe`), but they're told exactly which guarantee
 * they just dropped.
 */
export function customDockerfileWarnings(content: string): string[] {
  return REQUIRED_MARKERS.filter((m) => !content.includes(m.needle)).map((m) => `custom Dockerfile is missing ${m.missing}`);
}
