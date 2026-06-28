import { isCustomBuild } from './image.js';
import type { RunPlan } from './plan.js';

/**
 * Render a {@link RunPlan} as a plain-English preview — what `--dry-run` shows instead of running.
 *
 * `--json` already exposes the exact plan for machines; this is the human-facing companion. For a
 * security tool whose headline use is "I'm about to let an agent / a random repo install", being
 * able to *read* the boundary (what's writable, what's read-only, where it can reach, what was
 * granted) before anything executes is the point — no `jq`, no JSON literacy required.
 */

/** Env keys the runtime always sets; they're noise in a grants summary. */
const AMBIENT_ENV = new Set(['SANDBOX', 'CI', 'HOME', 'SSH_AUTH_SOCK']);

function networkLine(plan: RunPlan): string {
  switch (plan.network) {
    case 'none':
      return 'no network (fully isolated)';
    case 'on':
      return 'full network (host bridge)';
    case 'allowlist':
      return `allowlist, reaches only: ${plan.egressAllow.join(', ') || '(none)'}`;
  }
}

/** Strip the `/workspace` prefix so read-only targets read as repo-relative paths. */
function shortTarget(target: string): string {
  if (target === '/workspace') return '/workspace (project root)';
  return target.startsWith('/workspace/') ? target.slice('/workspace/'.length) : target;
}

/** When the image isn't the bundled default, show what changed (and whether the boundary holds). */
function buildLine(plan: RunPlan): string | undefined {
  const b = plan.build;
  if (!isCustomBuild(b)) return undefined;
  if (b.customDockerfile) return `  build     custom Dockerfile: ${b.customDockerfile}, boundary NOT verified by sandbox`;
  const extras = [
    ...(b.extraPackages.length ? [`+pkgs ${b.extraPackages.join(' ')}`] : []),
    ...(b.extraSteps.length ? [`+${b.extraSteps.length} step${b.extraSteps.length === 1 ? '' : 's'}`] : []),
  ];
  return `  build     base ${b.baseImage}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
}

export function renderPlanSummary(plan: RunPlan): string {
  const lines = [
    'sandbox: dry run, nothing was executed',
    `  command   ${plan.argv.join(' ')}`,
    `  image     ${plan.image}`,
    `  workdir   ${plan.workdir}`,
    `  network   ${networkLine(plan)}`,
  ];

  const build = buildLine(plan);
  if (build) lines.splice(3, 0, build);

  for (const m of plan.mounts) {
    if (m.type === 'bind' && !m.readonly) lines.push(`  writable  ${m.source} -> ${m.target}`);
  }

  const readonly = plan.mounts.filter((m) => m.readonly).map((m) => shortTarget(m.target));
  if (readonly.length) lines.push(`  readonly  ${readonly.join(', ')}`);

  // Named (persistent) volumes — the package-manager cache. Anonymous read-only block volumes are
  // covered by the readonly line above; only surface the named, writable ones here.
  const cache = plan.mounts.filter((m) => m.type === 'volume' && m.source && !m.readonly);
  for (const m of cache) lines.push(`  cache     ${m.source} (persists ${m.target} across runs)`);

  const granted = Object.keys(plan.env).filter((k) => !AMBIENT_ENV.has(k) && plan.env[k] !== '');
  const grants = [...(plan.env.SSH_AUTH_SOCK ? ['ssh-agent (sign only, key bytes stay out)'] : []), ...granted];
  lines.push(`  grants    ${grants.length ? grants.join(', ') : 'none; host credentials stay out'}`);
  lines.push(`  ports     ${plan.ports.length ? plan.ports.join(', ') : 'none'}`);
  lines.push(`  security  ${plan.capDrop.includes('ALL') ? 'cap-drop ALL · ' : ''}${plan.securityOpt.join(' · ')} · container-root ≠ host-root`);

  return lines.join('\n');
}
