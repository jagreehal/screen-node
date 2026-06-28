import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leaderForBin } from '../src/native.js';

/**
 * screen-node ships only the terse `s<pm>` aliases (s = screen). Three places must
 * agree for them to work: the `bin` field in package.json (what npm installs as
 * executables), `leaderForBin`/BIN_LEADER (the from-source/dev fallback), and the
 * `bin/*.mjs` launchers (which set SANDBOX_PM_BIN for the published path). They're
 * maintained by hand, so this guard fails the build if any drifts: a launcher
 * pointing at the wrong leader would otherwise silently run the wrong PM.
 */
const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { bin: Record<string, string> };

const LEADERS = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx'] as const;
const SHORT: Record<(typeof LEADERS)[number], string> = { npm: 'snpm', pnpm: 'spnpm', yarn: 'syarn', bun: 'sbun', npx: 'snpx', bunx: 'sbunx' };
const CLI_BINS = new Set(['screen']);
const pmBins = Object.entries(pkg.bin).filter(([name]) => !CLI_BINS.has(name));

describe('per-PM binary parity (package.json bin ↔ leaderForBin ↔ bin/ launchers)', () => {
  it('ships a terse `s<pm>` alias for every leader', () => {
    for (const leader of LEADERS) {
      const short = SHORT[leader];
      expect(pkg.bin[short], short).toBeDefined();
    }
    expect(pmBins.length, 'exactly 6 leaders, s<pm> only').toBe(6);
  });

  it('leaderForBin resolves every shipped PM bin to the leader its launcher actually sets', () => {
    for (const [name, rel] of pmBins) {
      const leader = leaderForBin(name);
      expect(leader, `leaderForBin(${name})`).toBeDefined();
      const launcher = readFileSync(path.join(root, rel), 'utf8');
      const m = launcher.match(/SANDBOX_PM_BIN\s*=\s*['"]([^'"]+)['"]/);
      expect(m, `${rel} sets SANDBOX_PM_BIN`).not.toBeNull();
      expect(m![1], `${name} -> ${rel} leader`).toBe(leader);
    }
  });

  it('does not treat the CLI bin as a PM front-end', () => {
    expect(leaderForBin('screen')).toBeUndefined();
  });
});
