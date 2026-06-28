import { describe, expect, it } from 'vitest';
import { canPromptInteractively, nextPlanForBlockedEgressChoice } from '../src/interactive.js';
import type { RunPlan } from '../src/plan.js';

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    image: 'node-install-sandbox:latest',
    build: { tag: 'node-install-sandbox:latest', baseImage: 'node:24-bookworm-slim', extraPackages: [], extraSteps: [], buildContext: '/tmp/project' },
    argv: ['npm', 'install'],
    env: { SANDBOX: '1', HOME: '/root' },
    mounts: [],
    ports: [],
    workdir: '/workspace',
    network: 'allowlist',
    egressAllow: ['npmjs.com', 'npmjs.org'],
    interactive: false,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges'],
    addHosts: [],
    ...overrides,
  };
}

describe('interactive remediation', () => {
  it('only prompts when explicitly enabled on a real TTY', () => {
    expect(canPromptInteractively(false, { isTTY: true }, { isTTY: true })).toBe(false);
    expect(canPromptInteractively(true, { isTTY: false }, { isTTY: true })).toBe(false);
    expect(canPromptInteractively(true, { isTTY: true }, { isTTY: false })).toBe(false);
    expect(canPromptInteractively(true, { isTTY: true }, { isTTY: true })).toBe(true);
  });

  it('allow-once retries with the blocked hosts merged into the allowlist', () => {
    const next = nextPlanForBlockedEgressChoice(plan(), ['exfil.example.com', 'npmjs.org'], 'allow-once');
    expect(next?.network).toBe('allowlist');
    expect(next?.egressAllow).toEqual(['exfil.example.com', 'npmjs.com', 'npmjs.org']);
  });

  it('full-network retries without the allowlist boundary', () => {
    const next = nextPlanForBlockedEgressChoice(plan(), ['exfil.example.com'], 'full-network');
    expect(next?.network).toBe('on');
    expect(next?.egressAllow).toEqual([]);
  });

  it('allow-project and allow-local widen this run the same way allow-once does (persistence is the CLI\'s job)', () => {
    for (const choice of ['allow-project', 'allow-local'] as const) {
      const next = nextPlanForBlockedEgressChoice(plan(), ['internal.example.com'], choice);
      expect(next?.network).toBe('allowlist');
      expect(next?.egressAllow).toEqual(['internal.example.com', 'npmjs.com', 'npmjs.org']);
    }
  });

  it('cancel stops the remediation loop', () => {
    expect(nextPlanForBlockedEgressChoice(plan(), ['exfil.example.com'], 'cancel')).toBeUndefined();
  });
});
