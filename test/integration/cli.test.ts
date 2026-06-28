import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, runCli } from './helpers.js';

function fakeDocker(dir: string): string {
  const bin = path.join(dir, 'docker');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Docker version 27.0.0"
  exit 0
fi
if [ "$1" = "info" ]; then
  echo "server ready"
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  exit 1
fi
if [ "$1" = "build" ]; then
  exit 0
fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

async function withRegistry(packuments: Record<string, unknown>, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    const body = packuments[name];
    if (!body) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind registry test server');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('cli (golden, no docker)', () => {
  it('prints help with all commands and globals', async () => {
    const { code, stdout } = await runCli(process.cwd(), ['help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Quick start:');
    expect(stdout).toContain('screen install');
    expect(stdout).toContain('screen add zod');
    for (const token of ['init', 'setup', 'allow', 'check', 'preflight', 'doctor', 'build', 'install', 'add', 'remove', 'run', 'shell', '--config', '--image', '--backend', '--dev', '--interactive', '--full-network', '--frozen', '--risk', '--fail-on-risk', '--json']) {
      expect(stdout).toContain(token);
    }
  });

  it('SCREEN_OFF runs the command on the host, no container', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    // `run -- node -e …` executes on the host when off; the marker proves no Docker was involved.
    const { code, stdout, stderr } = await runCli(dir, ['run', '--', 'node', '-e', 'console.log("HOST-RAN")'], { SCREEN_OFF: '1' });
    expect(code).toBe(0);
    expect(stdout).toContain('HOST-RAN');
    expect(stderr).toContain('screening is off (SCREEN_OFF)');
  });

  it('`sandbox off` git-ignores the personal override so it can\'t be committed for the whole team', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' }); // no init/setup run → no .gitignore yet
    const { code, stderr } = await runCli(dir, ['off']);
    expect(code).toBe(0);
    expect(stderr).toContain('containment is now off for this project');
    expect(existsSync(path.join(dir, 'screen.config.local.json'))).toBe(true);
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('screen.config.local.json');
  });

  it('off via config passes a bare pass-through command through verbatim (npm ci stays npm ci)', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}', 'screen.config.json': '{"off":true}' });
    const { code, stdout } = await runCli(dir, ['--dry-run', 'npm', 'ci']);
    expect(code).toBe(0);
    expect(stdout).toContain('off:true in config');
    expect(stdout).toContain('npm ci'); // verbatim — not rewritten to `npm install`
  });

  it('surfaces registry risk hints before install and can block on them', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    // Publish time is relative to now so the "<24h" strong signal fires deterministically;
    // a fixed date would silently stop triggering once real time drifts past the window.
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await withRegistry(
      {
        sharp: {
          name: 'sharp',
          'dist-tags': { latest: '0.33.5' },
          time: {
            created: '2024-01-01T00:00:00.000Z',
            '0.33.5': threeHoursAgo,
          },
          versions: {
            '0.33.5': {
              scripts: { postinstall: 'node install/check.js' },
              bin: { sharp: './cli.js' },
            },
          },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--fail-on-risk', 'npm', 'install', 'sharp@0.33.5'], {
          SANDBOX_NPM_REGISTRY: url,
        });
        expect(code).toBe(1);
        expect(stderr).toContain('checked 1 package');
        expect(stderr.match(/sharp@0\.33\.5/g)?.length).toBe(1);
        expect(stderr).toContain('has postinstall script (runs on your host during install)');
        expect(stderr).toContain('!! very recently published');
        expect(stderr).toContain('adds bin: sharp -> ./cli.js');
        expect(stderr).toContain('blocking because --fail-on-risk is set');
      },
    );
  });

  it('checks direct package.json deps for install commands with only flags', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'x',
        dependencies: { sharp: '^0.33.0' },
      }),
    });
    await withRegistry(
      {
        sharp: {
          name: 'sharp',
          'dist-tags': { latest: '0.33.5' },
          time: {
            created: '2024-01-01T00:00:00.000Z',
            '0.33.5': '2026-06-08T06:00:00.000Z',
          },
          versions: {
            '0.33.0': {},
            '0.33.5': {
              scripts: { postinstall: 'node install/check.js' },
            },
          },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--fail-on-risk', 'npm', 'install', '--foreground-scripts'], {
          SANDBOX_NPM_REGISTRY: url,
        });
        expect(code).toBe(1);
        expect(stderr).toContain('checked 1 package');
        expect(stderr.match(/sharp@0\.33\.5/g)?.length).toBe(1);
      },
    );
  });

  it('risk-checks the package an npx/dlx command would fetch and run', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(
      {
        sharp: {
          name: 'sharp',
          'dist-tags': { latest: '0.33.5' },
          time: { created: '2024-01-01T00:00:00.000Z', '0.33.5': '2026-06-08T06:00:00.000Z' },
          versions: { '0.33.5': { scripts: { postinstall: 'node install/check.js' } } },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--fail-on-risk', 'npx', 'sharp@0.33.5'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(1); // blocked before the container runs
        expect(stderr).toContain('checked 1 package');
        expect(stderr).toContain('has postinstall script (runs on your host during install)');
        expect(stderr).toContain('blocking because --fail-on-risk is set');
      },
    );
  });

  it('preflight blocks WITHOUT installing and suggests a known-good older version to pin', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await withRegistry(
      {
        'left-pad': {
          name: 'left-pad',
          'dist-tags': { latest: '1.3.0' },
          time: { created: '2020-01-01T00:00:00.000Z', '1.2.0': '2024-01-01T00:00:00.000Z', '1.3.0': threeHoursAgo },
          versions: { '1.2.0': {}, '1.3.0': {} },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--min-release-age', '7', 'preflight', 'npm', 'install', 'left-pad'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(1); // would block — but nothing installed (no backend invoked)
        expect(stderr).toContain('blocked by the release-age gate (min 7 days)');
        expect(stderr).toContain('screen npm add left-pad@1.2.0'); // the concrete pin
        expect(stderr).toContain('would BLOCK this install');
        expect(stderr).not.toContain('screen delta'); // adding an explicit package is NOT a reproduce
      },
    );
  });

  it('`check <pkg>` audits a bare package name directly, no install, no backend', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await withRegistry(
      {
        'left-pad': {
          name: 'left-pad',
          'dist-tags': { latest: '1.3.0' },
          time: { created: '2020-01-01T00:00:00.000Z', '1.2.0': '2024-01-01T00:00:00.000Z', '1.3.0': threeHoursAgo },
          versions: { '1.2.0': {}, '1.3.0': {} },
        },
      },
      async (url) => {
        // Bare name, no `npm install` prefix — the direct package-name form. No --fail-on-advisory needed:
        // `check` always queries, and --min-release-age makes the age gate block.
        const { code, stderr } = await runCli(dir, ['--min-release-age', '7', 'check', 'left-pad'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(1);
        expect(stderr).toContain('blocked by the release-age gate (min 7 days)');
        expect(stderr).toContain('screen npm add left-pad@1.2.0');
      },
    );
  });

  it('`check` with no args audits EVERY workspace package.json in a monorepo', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/api/package.json': JSON.stringify({ name: 'api', dependencies: { 'left-pad': '1.3.0' } }),
      'packages/web/package.json': JSON.stringify({ name: 'web', dependencies: { 'is-odd': '3.0.1' }, devDependencies: { api: 'workspace:*' } }),
    });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const fresh = (latest: string) => ({ 'dist-tags': { latest }, time: { created: '2020-01-01T00:00:00.000Z', [latest]: threeHoursAgo }, versions: { [latest]: {} } });
    await withRegistry(
      { 'left-pad': { name: 'left-pad', ...fresh('1.3.0') }, 'is-odd': { name: 'is-odd', ...fresh('3.0.1') } },
      async (url) => {
        const { code, stdout } = await runCli(dir, ['--json', '--min-release-age', '7', 'check'], { SANDBOX_NPM_REGISTRY: url });
        const out = JSON.parse(stdout);
        expect(code).toBe(1);
        const flagged = out.ageViolations.map((v: { name: string }) => v.name).sort();
        expect(flagged).toEqual(['is-odd', 'left-pad']); // both workspaces, NOT the `workspace:*` local dep
      },
    );
  });

  it('`check <file>.json` audits the dependencies declared in that specific manifest', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/api/package.json': JSON.stringify({ name: 'api', dependencies: { 'left-pad': '1.3.0' } }),
      'packages/web/package.json': JSON.stringify({ name: 'web', dependencies: { 'is-odd': '3.0.1' } }),
    });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const fresh = (latest: string) => ({ 'dist-tags': { latest }, time: { created: '2020-01-01T00:00:00.000Z', [latest]: threeHoursAgo }, versions: { [latest]: {} } });
    await withRegistry(
      { 'left-pad': { name: 'left-pad', ...fresh('1.3.0') }, 'is-odd': { name: 'is-odd', ...fresh('3.0.1') } },
      async (url) => {
        // Only the api manifest → only left-pad is audited (is-odd lives in the web package).
        const { code, stdout } = await runCli(dir, ['--json', '--min-release-age', '7', 'check', 'packages/api/package.json'], { SANDBOX_NPM_REGISTRY: url });
        const out = JSON.parse(stdout);
        expect(code).toBe(1);
        expect(out.ageViolations.map((v: { name: string }) => v.name)).toEqual(['left-pad']);
      },
    );
  });

  it('`check package.json` from a workspace SUBDIRECTORY resolves the manifest relative to the caller, not the root', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }), // root: no registry deps
      'packages/api/package.json': JSON.stringify({ name: 'api', dependencies: { 'left-pad': '1.3.0' } }),
    });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await withRegistry(
      { 'left-pad': { name: 'left-pad', 'dist-tags': { latest: '1.3.0' }, time: { created: '2020-01-01T00:00:00.000Z', '1.3.0': threeHoursAgo }, versions: { '1.3.0': {} } } },
      async (url) => {
        // Run from packages/api with a bare `package.json` — must audit api's manifest, not the root's.
        const { code, stdout } = await runCli(path.join(dir, 'packages', 'api'), ['--json', '--min-release-age', '7', 'check', 'package.json'], { SANDBOX_NPM_REGISTRY: url });
        const out = JSON.parse(stdout);
        expect(code).toBe(1); // would have been 0 (checked: 0) when resolving against the root
        expect(out.ageViolations.map((v: { name: string }) => v.name)).toEqual(['left-pad']);
      },
    );
  });

  it('steers a bare reproduce-install age block toward `sandbox delta` (existing deps, not new ones)', async () => {
    const dir = fixture({ 'package.json': JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.3.0' } }) });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await withRegistry(
      {
        'left-pad': {
          name: 'left-pad',
          'dist-tags': { latest: '1.3.0' },
          time: { created: '2020-01-01T00:00:00.000Z', '1.2.0': '2024-01-01T00:00:00.000Z', '1.3.0': threeHoursAgo },
          versions: { '1.2.0': {}, '1.3.0': {} },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--min-release-age', '7', 'preflight', 'npm', 'install'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(1);
        expect(stderr).toContain('blocked by the release-age gate (min 7 days)');
        expect(stderr).toContain('screen delta'); // the low-noise gate for an existing lockfile
      },
    );
  });

  it('preflight --json emits the findings plus a pin suggestion for the skill/agent', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await withRegistry(
      {
        'left-pad': {
          name: 'left-pad',
          'dist-tags': { latest: '1.3.0' },
          time: { created: '2020-01-01T00:00:00.000Z', '1.2.0': '2024-01-01T00:00:00.000Z', '1.3.0': threeHoursAgo },
          versions: { '1.2.0': {}, '1.3.0': {} },
        },
      },
      async (url) => {
        const { code, stdout } = await runCli(dir, ['--json', '--min-release-age', '7', 'preflight', 'npm', 'install', 'left-pad'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(1);
        const report = JSON.parse(stdout);
        expect(report.blocked).toBe(true);
        expect(report.ageViolations[0]).toMatchObject({ name: 'left-pad', version: '1.3.0' });
        expect(report.suggestions[0]).toMatchObject({ name: 'left-pad', version: '1.2.0', pin: 'screen npm add left-pad@1.2.0' });
      },
    );
  });

  it('preflight exits 0 with a clean report when nothing is blocked', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(
      {
        'is-odd': {
          name: 'is-odd',
          'dist-tags': { latest: '1.0.0' },
          time: { created: '2020-01-01T00:00:00.000Z', '1.0.0': '2024-01-01T00:00:00.000Z' },
          versions: { '1.0.0': {} },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--min-release-age', '7', 'preflight', 'npm', 'install', 'is-odd'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(0);
        expect(stderr).toContain('no blocking findings, safe to install');
      },
    );
  });

  const deprecatedRegistry = {
    'old-lib': {
      name: 'old-lib',
      'dist-tags': { latest: '2.0.0' },
      time: { created: '2020-01-01T00:00:00.000Z', '2.0.0': '2022-01-01T00:00:00.000Z' },
      versions: { '2.0.0': { deprecated: 'no longer maintained' } },
    },
  };

  it('blocks a maintainer-deprecated version by default, never install an abandoned version', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(deprecatedRegistry, async (url) => {
      // No gate flags: riskHints basic is on by default, so the deprecated gate blocks.
      const { code, stderr } = await runCli(dir, ['npm', 'install', 'old-lib'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(1); // blocked before the container runs
      expect(stderr).toContain('blocked: a maintainer-deprecated version');
      expect(stderr).toContain('old-lib@2.0.0, deprecated: no longer maintained');
      expect(stderr).toContain('--allow-deprecated');
    });
  });

  it('--allow-deprecated downgrades the deprecated block to a warning', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(deprecatedRegistry, async (url) => {
      const { code, stderr } = await runCli(dir, ['--allow-deprecated', 'preflight', 'npm', 'install', 'old-lib'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(0);
      expect(stderr).toContain('deprecated version(s) allowed via --allow-deprecated');
    });
  });

  it('preflight --json reports deprecations in their own field and blocks', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(deprecatedRegistry, async (url) => {
      const { code, stdout } = await runCli(dir, ['--json', 'preflight', 'npm', 'install', 'old-lib'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(1);
      const report = JSON.parse(stdout);
      expect(report.blocked).toBe(true);
      expect(report.deprecations[0]).toMatchObject({ name: 'old-lib', version: '2.0.0', reason: 'no longer maintained' });
    });
  });

  it('--risk off disables the deprecated gate (it rides on the risk resolution)', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(deprecatedRegistry, async (url) => {
      const { code } = await runCli(dir, ['--risk', 'off', 'preflight', 'npm', 'install', 'old-lib'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(0); // no risk resolution → no deprecated finding → nothing to block
    });
  });

  it('a monorepo preflight checks the workspace packages’ deps, not just the root manifest', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'root' }), // root has NO deps — the real surface is in the packages
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'packages/db/package.json': JSON.stringify({ dependencies: { 'old-lib': '^2.0.0', '@me/x': 'workspace:*' } }),
    });
    await withRegistry(deprecatedRegistry, async (url) => {
      // The deprecated dep lives in packages/db, and the install resolves to the root — the gate still catches it.
      // The local `@me/x: workspace:*` dep is dropped (never resolved against the registry).
      const { code, stderr } = await runCli(dir, ['preflight', 'pnpm', 'install'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(1);
      expect(stderr).toContain('old-lib@2.0.0, deprecated: no longer maintained');
    });
  });

  it('--deep catches a deprecated TRANSITIVE dep read from the lockfile', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'app' }), // no direct deps — the deprecated one is transitive
      'package-lock.json': JSON.stringify({ packages: { '': {}, 'node_modules/buried-dep': { version: '1.0.0' } } }),
    });
    await withRegistry(
      {
        'buried-dep': {
          name: 'buried-dep',
          'dist-tags': { latest: '1.0.0' },
          time: { created: '2020-01-01T00:00:00.000Z', '1.0.0': '2024-01-01T00:00:00.000Z' },
          versions: { '1.0.0': { deprecated: 'unmaintained, do not use' } },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--deep', 'preflight', 'npm', 'install'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(1); // a deprecated dep nobody declared directly still blocks under --deep
        expect(stderr).toContain('scanned 1 resolved packages');
        expect(stderr).toContain('buried-dep@1.0.0, deprecated: unmaintained, do not use');
      },
    );
  });

  it('--dev opens only run networking + dev ports for one run', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const install = JSON.parse((await runCli(dir, ['--json', '--dev', 'npm', 'install'])).stdout);
    expect(install.network).toBe('allowlist');
    const dev = JSON.parse((await runCli(dir, ['--json', '--dev', 'npm', 'run', 'dev'])).stdout);
    expect(dev.network).toBe('on');
    expect(dev.ports).toContain('5173:5173');
  });

  it('--full-network opens install and run networking for one run without enabling dev-port publishing', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const install = JSON.parse((await runCli(dir, ['--json', '--full-network', 'npm', 'install'])).stdout);
    expect(install.network).toBe('on');
    const dev = JSON.parse((await runCli(dir, ['--json', '--full-network', 'npm', 'run', 'dev'])).stdout);
    expect(dev.network).toBe('on');
    expect(dev.ports).toEqual([]);
  });

  it('`sandbox x` uses install-style networking so fetch fallback works without a separate run-network override', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const plan = JSON.parse((await runCli(dir, ['--json', 'x', 'vite'])).stdout);
    expect(plan.network).toBe('allowlist');
    expect(plan.ports).toEqual([]);
  });

  it('--allow-build-hosts widens egress to the curated native-build hosts (still default-deny otherwise)', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    // Force the container (explicit pm form) so the egress allowlist is part of the plan to inspect;
    // the friendly `install` on a fresh project is mode-aware and would resolve to a native install.
    const base = JSON.parse((await runCli(dir, ['--json', 'npm', 'install'])).stdout);
    expect(base.egressAllow).toEqual(['npmjs.org', 'npmjs.com']); // unchanged without the flag
    const widened = JSON.parse((await runCli(dir, ['--json', '--allow-build-hosts', 'npm', 'install'])).stdout);
    expect(widened.network).toBe('allowlist'); // still an allowlist, NOT full network
    expect(widened.egressAllow).toEqual(expect.arrayContaining(['npmjs.org', 'nodejs.org', 'github.com', 'binaries.prisma.sh']));
    expect(widened.egressAllow).not.toContain('exfil.example.com');
  });

  it('--json install (forced container): writable root, locked manifest + persistence paths', async () => {
    // Explicit pm form forces the container, so there is a container plan to inspect; the friendly
    // `install` is mode-aware (see the native-install tests below).
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'install']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.replaceAll(dir, '<cwd>'));
    expect(plan.image).toMatch(/^node-install-sandbox:/);
    expect(plan.env.CI).toBe('1');
    expect(plan).toMatchObject({
      argv: ['npm', 'install'],
      env: { SANDBOX: '1', HOME: '/root' },
      ports: [],
      workdir: '/workspace',
      network: 'allowlist', // default-deny egress
      egressAllow: ['npmjs.org', 'npmjs.com'],
      interactive: false,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges'],
      addHosts: [], // addHosts only on bridge ("on")
    });
    expect(plan.mounts).toContainEqual({ type: 'bind', source: '<cwd>', target: '/workspace', readonly: false });
    expect(plan.mounts).toContainEqual({ type: 'bind', source: '<cwd>/package.json', target: '/workspace/package.json', readonly: true });
    expect(plan.mounts).toContainEqual({ type: 'volume', target: '/workspace/.github', readonly: true });
  });

  it('--json add (forced container) leaves package.json writable and uses the add args', async () => {
    const dir = fixture({ 'pnpm-lock.yaml': '', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'pnpm', 'add', 'is-number']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'add', '--save-exact', 'is-number']);
    expect(plan.mounts.find((m: { target: string }) => m.target === '/workspace/package.json')).toBeUndefined();
    expect(plan.mounts).toContainEqual({ type: 'volume', target: '/workspace/.github', readonly: true });
  });

  it('mode-aware: the friendly `install` on a fresh project resolves to a native host install', async () => {
    // A fresh project (no node_modules) is not a container build, so the everyday `sandbox install`
    // installs natively, so the host IDE and tools load the result. --json reports it honestly.
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'install']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ native: true, host: true, argv: ['npm', 'install'] });
  });

  it('mode-aware: the friendly `add` on a fresh project resolves to a native host install with pins intact', async () => {
    const dir = fixture({ 'pnpm-lock.yaml': '', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'add', 'is-number']);
    expect(code).toBe(0);
    // Native carries the gate engine's safe-install pin (--save-exact), same as the contained path.
    expect(JSON.parse(stdout)).toEqual({ native: true, host: true, argv: ['corepack', 'pnpm', 'add', '--save-exact', 'is-number'] });
  });

  it('mode-aware: `approve-builds` re-install follows the project mode (native on a fresh host-native project)', async () => {
    // Regression: approve-builds must not hard-wire a contained reinstall. On a fresh/host-native pnpm
    // project that would clobber the tree with a Linux one; the reinstall now takes the mode-aware path.
    const dir = fixture({ 'pnpm-lock.yaml': '', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'approve-builds', 'esbuild']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ native: true, host: true, argv: ['corepack', 'pnpm', 'install'] });
  });

  it('--json run loads env files from the invocation directory but redacts their values', async () => {
    const dir = fixture({
      '.env.local': 'FROM_FILE=local\nOVERRIDE=file\n',
      'package.json': '{"name":"x"}',
    });
    const { code, stdout } = await runCli(dir, ['--env', 'OVERRIDE', '--env-file', '.env.local', '--json', 'run', '--', 'node', 'x.js'], {
      OVERRIDE: 'host',
    });
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.env.FROM_FILE).toBe('[redacted]');
    expect(plan.env.OVERRIDE).toBe('[redacted]');
    expect(plan.env.HOME).toBe('/root');
  });

  it('config env files resolve from the project root even when invoked from a leaf workspace package', async () => {
    const dir = fixture({
      'screen.config.json': JSON.stringify({ grants: { envFiles: ['.env'] } }),
      '.env': 'FROM_ROOT=1\n',
      'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }),
      'apps/web/package.json': '{"name":"web"}',
    });
    const { code, stdout } = await runCli(path.join(dir, 'apps', 'web'), ['--json', 'run', '--', 'node', 'x.js']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.env.FROM_ROOT).toBe('[redacted]');
  });

  it('pass-through: `npm install` maps to the install containment model', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'install']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.replaceAll(dir, '<cwd>'));
    expect(plan.argv).toEqual(['npm', 'install']);
    expect(plan.workdir).toBe('/workspace');
    expect(plan.mounts).toContainEqual({ type: 'bind', source: '<cwd>/package.json', target: '/workspace/package.json', readonly: true });
  });

  it('pass-through: `pnpm add` honours the named pm and maps to the add model', async () => {
    // npm lockfile present, but the user explicitly typed pnpm → pnpm wins.
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'pnpm', 'add', 'zod']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'add', '--save-exact', 'zod']);
    expect(plan.mounts.find((m: { target: string }) => m.target === '/workspace/package.json')).toBeUndefined(); // writable manifest
  });

  it('pass-through: `npm run dev` maps to the run model', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'run', 'dev']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['npm', 'run', 'dev']);
    expect(plan.interactive).toBe(true);
  });

  it('auto-script: `sandbox <script>` uses packageManager-native argv', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'x',
        packageManager: 'pnpm@11.5.1',
        scripts: { test: 'vitest' },
      }),
      'package-lock.json': '{}',
    });
    const { code, stdout } = await runCli(dir, ['--json', 'test']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['pnpm', 'test']);
    expect(plan.interactive).toBe(true);
  });

  it('auto-script: npm inserts `--` before forwarded script args', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'x',
        packageManager: 'npm@10.9.0',
        scripts: { lint: 'eslint .' },
      }),
    });
    const { code, stdout } = await runCli(dir, ['--json', 'lint', '--fix']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['npm', 'run', 'lint', '--', '--fix']);
  });

  it('`sandbox dev` falls back to start/serve and still uses native argv', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'x',
        packageManager: 'pnpm@11.5.1',
        scripts: { start: 'vite preview' },
      }),
    });
    const { code, stdout } = await runCli(dir, ['--json', 'dev', '--', '--host']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['pnpm', 'start', '--', '--host']);
    expect(plan.network).toBe('on');
    expect(plan.env.HOST).toBe('0.0.0.0');
  });

  it('builtin commands keep precedence over script fallback for best-effort predictability', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'x',
        packageManager: 'pnpm@11.5.1',
        scripts: { build: 'vite build' },
      }),
    });
    const { code, stdout } = await runCli(dir, ['--json', 'build']);
    expect(code).toBe(0);
    expect(stdout).toContain('"tag"');
    expect(stdout).not.toContain('vite build');
  });

  it('`sandbox script <name>` runs a colliding package.json script natively', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'x',
        packageManager: 'pnpm@11.5.1',
        scripts: { build: 'vite build' },
      }),
    });
    const { code, stdout } = await runCli(dir, ['--json', 'script', 'build', '--watch']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['pnpm', 'build', '--watch']);
  });

  it('`sandbox dev` opens dev-mode networking through the single effective config', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'x', packageManager: 'pnpm@11.5.1', scripts: { dev: 'vite' } }),
    });
    const { code, stdout } = await runCli(dir, ['--json', 'dev']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['pnpm', 'dev']);
    expect(plan.network).toBe('on'); // same as the `--dev` global one-off mode
    expect(plan.env.HOST).toBe('0.0.0.0');
  });

  it('preflight resolves package.json scripts too (run route → nothing to install → clean exit)', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'x', packageManager: 'pnpm@11.5.1', scripts: { test: 'vitest' } }),
    });
    // `sandbox test` is a script, not a pm command — preflight used to reject it as "unknown".
    const { code } = await runCli(dir, ['--min-release-age', '7', 'preflight', 'test']);
    expect(code).toBe(0);
  });

  it('unknown command surfaces one consistent error from both the run and preflight paths', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const run = await runCli(dir, ['definitely-not-a-script']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("unknown command 'definitely-not-a-script'");
    const pre = await runCli(dir, ['preflight', 'definitely-not-a-script']);
    expect(pre.code).toBe(1);
    expect(pre.stderr).toContain("unknown command 'definitely-not-a-script'");
  });

  it('pass-through: `npm audit fix` maps to the install-class audit-fix model', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'audit', 'fix', '--package-lock-only']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.replaceAll(dir, '<cwd>'));
    expect(plan.argv).toEqual(['npm', 'audit', 'fix', '--package-lock-only']);
    expect(plan.network).toBe('allowlist');
    expect(plan.workdir).toBe('/workspace');
    expect(plan.mounts.find((m: { target: string }) => m.target === '/workspace/package.json')).toBeUndefined();
  });

  it('pass-through: `pnpm audit --fix=update` honours the named pm and stays install-class', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'pnpm', 'audit', '--fix=update', '--prod']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'audit', '--fix=update', '--prod']);
    expect(plan.network).toBe('allowlist');
    expect(plan.interactive).toBe(false);
  });

  it('pass-through: `npm audit` uses registry egress but keeps the whole tree read-only', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'audit', '--json']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.replaceAll(dir, '<cwd>'));
    expect(plan.argv).toEqual(['npm', 'audit', '--json']);
    expect(plan.network).toBe('allowlist');
    expect(plan.mounts).toContainEqual({ type: 'bind', source: '<cwd>', target: '/workspace', readonly: true });
  });

  it('pass-through: `npm audit signatures` uses registry egress with protected persistence mounts', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'audit', 'signatures', '--json']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.replaceAll(dir, '<cwd>'));
    expect(plan.argv).toEqual(['npm', 'audit', 'signatures', '--json']);
    expect(plan.network).toBe('allowlist');
    expect(plan.mounts).toContainEqual({ type: 'bind', source: '<cwd>', target: '/workspace', readonly: true });
  });

  it('pass-through: `pnpm audit signatures` honours the named pm and stays read-only to the manifest', async () => {
    const dir = fixture({ 'pnpm-lock.yaml': '', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'pnpm', 'audit', 'signatures']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'audit', 'signatures']);
    expect(plan.network).toBe('allowlist');
    expect(plan.mounts.find((m: { target: string }) => m.target === '/workspace')).toMatchObject({ readonly: true });
    expect(plan.interactive).toBe(false);
  });

  it('audit-fix preflight gates the incoming vulnerable direct dependency versions before running', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'x', dependencies: { 'old-lib': '^2.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'old-lib': '^2.0.0' } }, 'node_modules/old-lib': { version: '2.0.0' } } }),
    });
    await withRegistry(deprecatedRegistry, async (url) => {
      const { code, stderr } = await runCli(dir, ['npm', 'audit', 'fix'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(1);
      expect(stderr).toContain('old-lib@2.0.0, deprecated: no longer maintained');
    });
  });

  it('init --preset writes a valid config (and won’t clobber without --force)', async () => {
    const dir = fixture({});
    const first = await runCli(dir, ['init', '--preset', 'strict']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('screen: wrote screen.config.json using the strict preset');
    expect(first.stdout).toContain('screen install'); // beginner write path in Next commands (not `sandbox npm install`)
    const cfg = JSON.parse(readFileSync(path.join(dir, 'screen.config.json'), 'utf8'));
    expect(cfg.install).toEqual({
      network: 'allowlist',
      frozen: true,
      riskHints: 'thorough',
      failOnRisk: false,
      minReleaseAgeDays: 7,
      minReleaseAgeExclude: [],
      failOnAdvisory: true,
      malwareFeeds: [],
      failOnDeprecated: true,
      cache: true,
      canaries: true,
      failOnSourceWrites: true, // strict opts into the source-write tripwire (catches the pnpm writable-root case)
      safeInstall: true,
      pinExact: false,
    });
    expect(cfg.run.network).toBe('none');

    const clobber = await runCli(dir, ['init', '--preset', 'trusted']);
    expect(clobber.code).toBe(1);
    expect(clobber.stderr).toMatch(/already exists/);

    const forced = await runCli(dir, ['init', '--preset', 'trusted', '--force']);
    expect(forced.code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, 'screen.config.json'), 'utf8')).install.network).toBe('on');
  });

  it('first-run init prints the project mode and demotes the per-PM binaries to an advanced tip', async () => {
    // Golden transcript for first contact: a fresh project surfaces its mode (no deps yet), points at
    // the beginner write path, and frames sandbox-<pm>/s<pm> as an advanced shortcut, not the default.
    const dir = fixture({});
    const { code, stdout } = await runCli(dir, ['init', '--preset', 'balanced']);
    expect(code).toBe(0);
    expect(stdout).toContain('project mode: no deps installed yet'); // mode is visible, not hidden in setup
    expect(stdout).toMatch(/Tip: advanced: s(npm|pnpm|yarn|bun) add zod uses the same mode-aware path/); // expert-only framing
    expect(stdout).toContain('screen install'); // the beginner write path is still front-and-centre
  });

  it('init --agent writes repo instructions and wires the enforcement hook', async () => {
    const dir = fixture({});
    const { code, stdout } = await runCli(dir, ['init', '--agent']);
    expect(code).toBe(0);
    expect(stdout).toContain('screen: wrote .sandbox/AGENT.md');
    expect(stdout).toContain('wired .claude/settings.json');
    expect(readFileSync(path.join(dir, '.sandbox', 'AGENT.md'), 'utf8')).toContain('Use `screen install`, not `npm install`');
    expect(readFileSync(path.join(dir, '.sandbox', 'hooks', 'enforce-sandbox.mjs'), 'utf8')).toContain('Blocked by sandbox');
    expect(JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command).toContain('enforce-sandbox.mjs');
  });

  it('setup --vibe writes config, checks the backend, builds images, and prints next commands', async () => {
    const dir = fixture({});
    const fakePath = fakeDocker(dir);
    const { code, stdout } = await runCli(dir, ['setup', '--vibe'], { PATH: `${fakePath}:${process.env.PATH ?? ''}` });
    expect(code).toBe(0);
    expect(stdout).toContain('screen: wrote screen.config.json using the vibe preset');
    expect(stdout).toContain('screen: backend ready: Docker version 27.0.0');
    expect(stdout).toContain('screen: building node-install-sandbox:latest and the egress proxy image');
    expect(stdout).toContain('screen: vibe preset');
    expect(stdout).toContain('screen install'); // beginner write path in Next commands (not `sandbox npm install`)
    expect(stdout).toContain('screen dev');
    expect(existsSync(path.join(dir, 'screen.config.json'))).toBe(true);
  });

  it('allow adds hosts to egress.allow', async () => {
    const dir = fixture({ 'screen.config.json': '{}' });
    const { code, stdout } = await runCli(dir, ['allow', 'nodejs.org', 'https://npm.pkg.github.com/path']);
    expect(code).toBe(0);
    expect(stdout).toContain('allowed nodejs.org, npm.pkg.github.com');
    const cfg = JSON.parse(readFileSync(path.join(dir, 'screen.config.json'), 'utf8'));
    expect(cfg.egress.allow).toEqual(['nodejs.org', 'npm.pkg.github.com', 'npmjs.com', 'npmjs.org']);
  });

  it('init rejects an unknown preset', async () => {
    const { code, stderr } = await runCli(fixture({}), ['init', '--preset', 'nope']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown preset/);
  });

  it('doctor reports a missing backend clearly', async () => {
    const { code, stdout } = await runCli(fixture({}), ['doctor'], { PATH: '' });
    expect(code).toBe(1);
    expect(stdout).toContain('[info] config:');
    expect(stdout).toContain('[info] package manager:');
    expect(stdout).toContain('[fail] backend:');
    expect(stdout).toContain('fix:');
  });

  it('doctor reports workspace root and package workdir from a monorepo package', async () => {
    const dir = fixture({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'screen.config.json': '{}',
      'apps/web/package.json': '{"name":"web"}',
    });
    const { code, stdout } = await runCli(path.join(dir, 'apps', 'web'), ['doctor'], { PATH: '' });
    expect(code).toBe(1);
    expect(stdout).toContain(`[info] workspace root: ${dir}`);
    expect(stdout).toContain('[info] package workdir: /workspace/apps/web');
  });

  it('doctor suggests private registry allowlist and auth grants from .npmrc', async () => {
    const dir = fixture({
      '.npmrc': '@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n',
      'screen.config.json': '{}',
    });
    const { stdout } = await runCli(dir, ['doctor'], { PATH: '' });
    expect(stdout).toContain('npm.pkg.github.com');
    expect(stdout).toContain('missing from egress.allow');
    expect(stdout).toContain('screen allow npm.pkg.github.com');
    expect(stdout).toContain('GITHUB_TOKEN');
    expect(stdout).toContain('"egress": {');
    expect(stdout).toContain('"grants":{"env"');
  });

  it('rejects `add` with no packages', async () => {
    const { code, stderr } = await runCli(fixture({}), ['add']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/usage: screen add/);
  });

  it('rejects an unknown command', async () => {
    const { code, stderr } = await runCli(fixture({}), ['frobnicate']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown command/);
  });

  it('reports an invalid config instead of running', async () => {
    const dir = fixture({ 'screen.config.json': '{ "run": { "network": "wide-open" } }' });
    const { code, stderr } = await runCli(dir, ['--json', 'install']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/invalid config/i);
  });

  describe('verify --sign (signed receipt scope)', () => {
    const GREEN = '{ "install": { "network": "allowlist" }, "run": { "network": "none" }, "egress": { "allow": ["npmjs.org"] } }';

    // A private signing key written OUTSIDE the scanned project (so --secrets doesn't flag the key itself).
    async function keyFile(dir: string): Promise<string> {
      const { stdout } = await runCli(dir, ['--json', 'keygen']);
      const key = (JSON.parse(stdout) as { privateKeyPem: string }).privateKeyPem;
      const file = path.join(dir, 'signing-key.pem');
      writeFileSync(file, key);
      return file;
    }

    it('signs a clean repo and the receipt records the checks it attests', async () => {
      const dir = fixture({ 'screen.config.json': GREEN });
      const proj = fixture({ 'screen.config.json': GREEN }); // separate dir to scan (no key file inside)
      const { code, stdout } = await runCli(proj, ['verify', '--sign', '--secrets'], { SANDBOX_SIGNING_KEY: await keyFile(dir) });
      expect(code).toBe(0);
      const receipt = JSON.parse(stdout) as { alg: string; payload: { checks: string[] } };
      expect(receipt.alg).toBe('ed25519');
      expect(receipt.payload.checks).toEqual(['boundary', 'secrets']);
    });

    it('REFUSES to sign when --secrets finds a committed credential (no receipt on stdout)', async () => {
      const proj = fixture({
        'screen.config.json': GREEN,
        '.env': 'OPENAI_API_KEY=sk-' + 'z'.repeat(40) + '\n',
      });
      const keyDir = fixture({});
      const { code, stdout, stderr } = await runCli(proj, ['verify', '--sign', '--secrets'], { SANDBOX_SIGNING_KEY: await keyFile(keyDir) });
      expect(code).toBe(1);
      expect(stdout.trim()).toBe(''); // critically: NO signed "green" receipt was emitted
      expect(stderr).toMatch(/not signing/);
    });
  });
});
