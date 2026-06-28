import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards that every bin/ launcher referenced by package.json exists on disk — a
 * missing launcher would ship a broken binary. (The CLI bin points at built
 * dist/, which is not present in the source tree, so only bin/ paths are checked.)
 */
const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { bin: Record<string, string>; files: string[] };

describe('packaging: bin launchers', () => {
  it('ships every bin/ launcher referenced by package.json', () => {
    for (const rel of Object.values(pkg.bin)) {
      const p = rel.replace(/^\.\//, '');
      if (!p.startsWith('bin/')) continue; // dist/ is built, not in the source tree
      expect(existsSync(path.join(root, p)), p).toBe(true);
    }
  });
});

/**
 * screen-node is container-free: the inherited Docker/container subsystem (image, egress proxy,
 * firewall) has been removed. Guard that no container artifact creeps back into the repo or the
 * published tarball, so the "no Docker" promise can't silently regress.
 */
describe('packaging: container-free', () => {
  const containerArtifacts = ['Dockerfile', 'net-guard.sh', 'proxy'];

  it('keeps no container artifacts in the repo', () => {
    for (const artifact of containerArtifacts) {
      expect(existsSync(path.join(root, artifact)), artifact).toBe(false);
    }
  });

  it('lists no container artifacts in package.json files', () => {
    for (const artifact of containerArtifacts) {
      expect(pkg.files, `files must not ship ${artifact}`).not.toContain(artifact);
    }
  });
});
