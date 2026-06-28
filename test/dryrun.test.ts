import { describe, expect, it } from 'vitest';
import { renderPlanSummary } from '../src/dryrun.js';
import type { RunPlan } from '../src/plan.js';

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    image: 'node-install-sandbox:latest',
    build: { tag: 'node-install-sandbox:latest', baseImage: 'node:24-bookworm-slim', extraPackages: [], extraSteps: [], buildContext: '/Users/you/app' },
    argv: ['npm', 'install'],
    env: { SANDBOX: '1', CI: '', HOME: '/root' },
    mounts: [
      { type: 'bind', source: '/Users/you/app', target: '/workspace', readonly: false },
      { type: 'bind', source: '/Users/you/app/.git', target: '/workspace/.git', readonly: true },
      { type: 'bind', source: '/Users/you/app/package.json', target: '/workspace/package.json', readonly: true },
    ],
    ports: [],
    workdir: '/workspace',
    network: 'allowlist',
    egressAllow: ['npmjs.org', 'npmjs.com'],
    interactive: false,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges'],
    addHosts: [],
    ...overrides,
  };
}

describe('renderPlanSummary', () => {
  it('shows the command, image, writable + read-only mounts, and the egress allowlist', () => {
    const out = renderPlanSummary(plan());
    expect(out).toContain('dry run, nothing was executed');
    expect(out).toContain('command   npm install');
    expect(out).toContain('writable  /Users/you/app -> /workspace');
    expect(out).toContain('readonly  .git, package.json'); // /workspace prefix stripped
    expect(out).toContain('allowlist, reaches only: npmjs.org, npmjs.com');
  });

  it('reports no credentials granted by default (ambient env is hidden)', () => {
    expect(renderPlanSummary(plan())).toContain('grants    none; host credentials stay out');
  });

  it('surfaces a granted env var and ssh-agent', () => {
    const out = renderPlanSummary(plan({ env: { SANDBOX: '1', CI: '', HOME: '/root', SSH_AUTH_SOCK: '/ssh-agent', NPM_TOKEN: 'secret' } }));
    expect(out).toContain('ssh-agent (sign only, key bytes stay out)');
    expect(out).toContain('NPM_TOKEN');
    expect(out).not.toContain('secret'); // names the grant, never prints the value
  });

  it('describes each network mode in plain words', () => {
    expect(renderPlanSummary(plan({ network: 'none' }))).toContain('no network (fully isolated)');
    expect(renderPlanSummary(plan({ network: 'on' }))).toContain('full network (host bridge)');
  });

  it('lists published ports when present', () => {
    expect(renderPlanSummary(plan({ ports: ['5173:5173', '3000:3000'] }))).toContain('ports     5173:5173, 3000:3000');
  });
});
