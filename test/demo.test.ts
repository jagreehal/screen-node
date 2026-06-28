import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/log.js';
import { SandboxConfigSchema } from '../src/config.js';
import { probeProject } from '../src/project.js';
import { DEMO_SCENARIOS, demoPlan, IMDS_BLOCKED_CODE, runDemo, type DemoOutcome, type DemoScenario } from '../src/demo.js';

const byId = (id: string): DemoScenario => {
  const s = DEMO_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

describe('scenario containment predicates', () => {
  it('persistence-write is contained only when the write fails (non-zero exit)', () => {
    const s = byId('persistence-write');
    expect(s.contained({ code: 1, deniedHosts: [], canaryHits: [] })).toBe(true);
    expect(s.contained({ code: 0, deniedHosts: [], canaryHits: [] })).toBe(false); // hook written = breach
  });

  it('credential-theft is contained when there is nothing to read (cat exits non-zero)', () => {
    const s = byId('credential-theft');
    expect(s.contained({ code: 1, deniedHosts: [], canaryHits: [] })).toBe(true);
    expect(s.contained({ code: 0, deniedHosts: [], canaryHits: [] })).toBe(false);
  });

  it('metadata-pivot is contained only on the IMDS-unreachable sentinel', () => {
    const s = byId('metadata-pivot');
    expect(s.contained({ code: IMDS_BLOCKED_CODE, deniedHosts: [], canaryHits: [] })).toBe(true);
    expect(s.contained({ code: 0, deniedHosts: [], canaryHits: [] })).toBe(false); // reached IMDS
    expect(s.contained({ code: 1, deniedHosts: [], canaryHits: [] })).toBe(false); // crashed ≠ contained
  });

  it('egress-exfil is contained when the host is refused OR the canary trips', () => {
    const s = byId('egress-exfil');
    expect(s.contained({ code: 0, deniedHosts: ['sandbox-demo-exfil.invalid'], canaryHits: [] })).toBe(true);
    expect(s.contained({ code: 0, deniedHosts: [], canaryHits: ['cnry…'] })).toBe(true);
    expect(s.contained({ code: 0, deniedHosts: [], canaryHits: [] })).toBe(false);
    expect(s.needs.canaries).toBe(true); // the exfil demo plants a honeytoken
  });
});

describe('demoPlan (the wiring the live runner uses)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sbx-demoplan-'));
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"x","private":true}');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const config = SandboxConfigSchema.parse({});
  const facts = () => probeProject(dir, config, { envFiles: [], envFileBaseDir: dir, configEnvFilesBaseDir: dir });
  const persistence = DEMO_SCENARIOS.find((s) => s.id === 'persistence-write')!;

  it('mounts .git READ-ONLY for the persistence attack (regression: run model alone leaves it writable)', () => {
    const plan = demoPlan(persistence, config, facts());
    const gitMount = plan.mounts.find((m) => m.target === '/workspace/.git');
    expect(gitMount, 'demo plan must protect .git').toBeDefined();
    expect(gitMount!.readonly).toBe(true);
  });

  it('runs the attack as a hostile repo: registry-only egress, every host grant stripped', () => {
    const plan = demoPlan(persistence, config, facts());
    expect(plan.egressAllow).toEqual(['registry.npmjs.org']);
    // No credential/grant binds (ssh-agent socket, env-file values, etc.) leak into the demo container.
    expect(plan.mounts.some((m) => m.target === '/ssh-agent')).toBe(false);
    expect(plan.argv).toEqual(persistence.attack);
  });

  it('forces the scenario network mode (metadata-pivot needs the bridge)', () => {
    const metadata = DEMO_SCENARIOS.find((s) => s.id === 'metadata-pivot')!;
    expect(demoPlan(metadata, config, facts()).network).toBe('on');
    expect(demoPlan(persistence, config, facts()).network).toBe('none');
  });
});

describe('runDemo', () => {
  const capture = () => {
    const lines: string[] = [];
    return { logger: createLogger({ sink: (l) => lines.push(l) }), lines };
  };

  it('returns 0 and reports CONTAINED when every attack is stopped', async () => {
    const { logger, lines } = capture();
    const runner = vi.fn(async (s: DemoScenario): Promise<DemoOutcome> => {
      if (s.id === 'metadata-pivot') return { code: IMDS_BLOCKED_CODE, deniedHosts: [], canaryHits: [] };
      if (s.id === 'egress-exfil') return { code: 0, deniedHosts: ['sandbox-demo-exfil.invalid'], canaryHits: ['cnryabc'] };
      return { code: 1, deniedHosts: [], canaryHits: [] };
    });
    const code = await runDemo(runner, { logger });
    expect(code).toBe(0);
    expect(runner).toHaveBeenCalledTimes(DEMO_SCENARIOS.length);
    expect(lines.join('\n')).toMatch(/all \d+ attack\(s\) contained/);
  });

  it('returns 1 when an attack is NOT contained', async () => {
    const { logger, lines } = capture();
    const runner = async (s: DemoScenario): Promise<DemoOutcome> =>
      s.id === 'persistence-write' ? { code: 0, deniedHosts: [], canaryHits: [] } : { code: IMDS_BLOCKED_CODE, deniedHosts: ['x'], canaryHits: [] };
    const code = await runDemo(runner, { logger });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/NOT CONTAINED/);
  });

  it('counts a runner error as a failure, never a silent pass', async () => {
    const { logger, lines } = capture();
    const runner = async (): Promise<DemoOutcome> => {
      throw new Error('docker daemon not running');
    };
    const code = await runDemo(runner, { logger, scenarios: [byId('persistence-write')] });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/could not run scenario.*docker daemon/);
  });
});
