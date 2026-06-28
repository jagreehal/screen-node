import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderRunArgs } from '../src/backend.js';
import { SandboxConfigSchema } from '../src/config.js';
import { BAKED_YARN_DLX } from '../src/image.js';
import { planAdd, planAudit, planAuditFix, planAuditSignatures, planInstall, planRemove, planRun, planUpdate, type Mount } from '../src/plan.js';
import type { ProjectFacts } from '../src/project.js';

const cfg = (over: object = {}) => SandboxConfigSchema.parse(over);

const CWD = '/proj';

/** A pure ProjectFacts — the planners read nothing else from the host. */
function facts(over: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    cwd: CWD,
    pm: 'npm',
    isYarnBerry: false,
    hasLockfile: false,
    hasPackageJson: false,
    scripts: {},
    directDependencies: [],
    existingPersistencePaths: [],
    homedir: '/home/dev',
    hostEnv: {},
    envFileValues: {},
    ...over,
  };
}

const find = (mounts: Mount[], target: string) => mounts.find((m) => m.target === target);

describe('warm cache volume', () => {
  it('mounts a per-manager named cache volume on install by default', () => {
    const plan = planInstall(cfg(), facts({ pm: 'npm', hasPackageJson: true }));
    const cache = find(plan.mounts, '/root/.npm');
    expect(cache).toMatchObject({ type: 'volume', source: 'sandbox-cache-npm', readonly: false });
  });

  it('uses the right store path per package manager', () => {
    expect(find(planInstall(cfg(), facts({ pm: 'pnpm' })).mounts, '/root/.local/share/pnpm/store')?.source).toBe('sandbox-cache-pnpm');
    expect(find(planInstall(cfg(), facts({ pm: 'bun' })).mounts, '/root/.bun/install/cache')?.source).toBe('sandbox-cache-bun');
    expect(find(planInstall(cfg(), facts({ pm: 'yarn' })).mounts, '/root/.cache/yarn')?.source).toBe('sandbox-cache-yarn');
  });

  it('survives a fully read-only frozen tree (cache lives under HOME, not the workspace)', () => {
    const plan = planInstall(cfg({ install: { frozen: true } }), facts({ pm: 'npm', hasLockfile: true }));
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(true); // tree locked
    expect(find(plan.mounts, '/root/.npm')?.readonly).toBe(false); // cache still writable
  });

  it('is omitted when install.cache is off, keeping the plan a faithful record', () => {
    const plan = planInstall(cfg({ install: { cache: false } }), facts({ pm: 'npm' }));
    expect(plan.mounts.some((m) => m.type === 'volume' && m.source?.startsWith('sandbox-cache-'))).toBe(false);
  });

  it('renders a named volume into docker --mount args with source=', () => {
    const plan = planInstall(cfg(), facts({ pm: 'npm' }));
    const args = renderRunArgs(plan).join(' ');
    expect(args).toContain('type=volume,source=sandbox-cache-npm,target=/root/.npm');
  });

  it('caches the fetch-and-run runners (npx → npm cache, bunx → bun cache)', () => {
    expect(find(planRun(cfg(), facts(), ['npx', 'cowsay']).mounts, '/root/.npm')?.source).toBe('sandbox-cache-npm');
    expect(find(planRun(cfg(), facts(), ['bunx', 'cowsay']).mounts, '/root/.bun/install/cache')?.source).toBe('sandbox-cache-bun');
    expect(find(planRun(cfg(), facts(), ['pnpm', 'dlx', 'cowsay']).mounts, '/root/.local/share/pnpm/store')?.source).toBe('sandbox-cache-pnpm');
  });

  it('normalizes lockfile-only `yarn dlx` to the baked Berry runtime so it needs no run-time manager download', () => {
    const plan = planRun(cfg(), facts({ pm: 'yarn', isYarnBerry: false }), ['yarn', 'dlx', 'cowsay']);
    expect(plan.argv).toEqual(['corepack', `yarn@${BAKED_YARN_DLX}`, 'dlx', 'cowsay']);
    expect(find(plan.mounts, '/root/.cache/yarn')?.source).toBe('sandbox-cache-yarn');
  });

  it('does NOT mount a cache for plain run commands that download nothing', () => {
    for (const argv of [['npm', 'test'], ['npm', 'run', 'dev'], ['node', 'app.js']]) {
      const plan = planRun(cfg(), facts(), argv);
      expect(plan.mounts.some((m) => m.type === 'volume' && m.source?.startsWith('sandbox-cache-')), argv.join(' ')).toBe(false);
    }
  });

  it('honours install.cache=false on the runner path too', () => {
    const plan = planRun(cfg({ install: { cache: false } }), facts(), ['npx', 'cowsay']);
    expect(plan.mounts.some((m) => m.type === 'volume' && m.source?.startsWith('sandbox-cache-'))).toBe(false);
  });
});

describe('effective egress allowlist (PM-aware)', () => {
  it('adds yarn classic’s registry so a yarn install works without widening the committed config', () => {
    expect(planInstall(cfg(), facts({ pm: 'yarn' })).egressAllow).toEqual(['npmjs.org', 'npmjs.com', 'yarnpkg.com']);
  });

  it('leaves npm/pnpm/bun on the minimal npm-registry default', () => {
    for (const pm of ['npm', 'pnpm', 'bun'] as const) {
      expect(planInstall(cfg(), facts({ pm })).egressAllow).toEqual(['npmjs.org', 'npmjs.com']);
    }
  });

  it('never duplicates yarnpkg.com when it is already in the committed allowlist', () => {
    const plan = planInstall(cfg({ egress: { allow: ['npmjs.org', 'yarnpkg.com'] } }), facts({ pm: 'yarn' }));
    expect(plan.egressAllow).toEqual(['npmjs.org', 'yarnpkg.com']);
  });
});

describe('planUpdate', () => {
  it('runs install-class: registry egress (default-deny allowlist), writable manifest, root workdir', () => {
    const plan = planUpdate(cfg(), facts({ hasPackageJson: true }), ['npm', 'update']);
    expect(plan.argv).toEqual(['npm', 'update']);
    expect(plan.network).toBe('allowlist'); // can resolve from the registry, not the open internet
    expect(plan.workdir).toBe('/workspace');
    // manifest writable (--save/--latest rewrite ranges; update is a deliberate dep change)
    expect(find(plan.mounts, '/workspace/package.json')).toBeUndefined();
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false);
    expect(plan.interactive).toBe(false);
  });
});

describe('planAuditFix', () => {
  it('runs audit remediation under install-class isolation', () => {
    const plan = planAuditFix(cfg(), facts({ pm: 'pnpm', hasPackageJson: true }), ['corepack', 'pnpm', 'audit', '--fix=update']);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'audit', '--fix=update']);
    expect(plan.network).toBe('allowlist');
    expect(plan.workdir).toBe('/workspace');
    expect(find(plan.mounts, '/workspace/package.json')).toBeUndefined();
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false);
    expect(plan.interactive).toBe(false);
  });
});

describe('planAudit', () => {
  it('runs read-only advisory audit with registry egress and a read-only tree', () => {
    const plan = planAudit(cfg({ grants: { claude: 'project' } }), facts({ hasPackageJson: true }), ['npm', 'audit', '--json']);
    expect(plan.argv).toEqual(['npm', 'audit', '--json']);
    expect(plan.network).toBe('allowlist');
    expect(plan.workdir).toBe('/workspace');
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(true);
    expect(find(plan.mounts, '/workspace/package.json')).toBeUndefined();
    expect(find(plan.mounts, '/root/.claude')?.readonly).toBe(true);
    expect(plan.interactive).toBe(false);
  });
});

describe('planAuditSignatures', () => {
  it('runs registry signature verification with allowlisted egress and a read-only tree (same boundary as audit)', () => {
    const plan = planAuditSignatures(cfg({ grants: { claude: 'project' } }), facts({ pm: 'pnpm', hasPackageJson: true }), ['corepack', 'pnpm', 'audit', 'signatures', '--json']);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'audit', 'signatures', '--json']);
    expect(plan.network).toBe('allowlist');
    expect(plan.workdir).toBe('/workspace');
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(true); // whole tree read-only — it writes nothing
    expect(find(plan.mounts, '/workspace/package.json')).toBeUndefined(); // covered by the read-only root, no separate mount
    expect(find(plan.mounts, '/root/.claude')?.readonly).toBe(true); // the agent's config stays locked too
    expect(plan.interactive).toBe(false);
  });
});

describe('planInstall', () => {
  it('keeps a writable root but read-only manifest + persistence paths', () => {
    const plan = planInstall(cfg(), facts({ hasPackageJson: true }), []);

    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false); // pnpm needs a writable root
    expect(find(plan.mounts, '/workspace/package.json')?.readonly).toBe(true); // install never mutates the manifest
    expect(find(plan.mounts, '/workspace/.github')?.readonly).toBe(true); // persistence vector locked
    expect(find(plan.mounts, '/workspace/.git')?.readonly).toBe(true);
    expect(plan.argv).toEqual(['npm', 'install']);
    expect(plan.env.SANDBOX).toBe('1');
    expect(plan.interactive).toBe(false);
  });

  it('blocks creation of a missing persistence dir via a read-only volume', () => {
    const plan = planInstall(cfg(), facts(), []); // no .github in facts
    const gh = find(plan.mounts, '/workspace/.github');
    expect(gh).toMatchObject({ type: 'volume', readonly: true });
    expect(gh?.source).toBeUndefined();
  });

  it('binds an existing persistence dir read-only', () => {
    const gh = find(planInstall(cfg(), facts({ existingPersistencePaths: ['.github'] }), []).mounts, '/workspace/.github');
    expect(gh).toMatchObject({ type: 'bind', readonly: true, source: path.join(CWD, '.github') });
  });

  it('emits the package manager argv from the probed facts', () => {
    expect(planInstall(cfg(), facts({ pm: 'pnpm' }), []).argv).toEqual(['corepack', 'pnpm', 'install']);
    expect(planInstall(cfg(), facts({ pm: 'yarn' }), []).argv).toEqual(['corepack', 'yarn', 'install']);
    expect(planInstall(cfg(), facts({ pm: 'bun' }), []).argv).toEqual(['bun', 'install']); // bun is a standalone binary — no corepack
  });

  it('passes extra args verbatim', () => {
    const plan = planInstall(cfg(), facts(), ['--workspace', 'api']);
    expect(plan.argv).toEqual(['npm', 'install', '--workspace', 'api']);
  });

  it('locks repo-scoped claude state during install-class commands (install/add/update)', () => {
    const cfgClaude = cfg({ grants: { claude: 'project' } });
    for (const plan of [
      planInstall(cfgClaude, facts(), []),
      planAdd(cfgClaude, facts(), ['zod']),
      planUpdate(cfgClaude, facts(), ['npm', 'update']),
    ]) {
      expect(find(plan.mounts, '/root/.claude')?.readonly).toBe(true); // a postinstall can't edit the agent's config
      expect(find(plan.mounts, '/workspace/.claude-sandbox')?.readonly).toBe(true);
    }
  });

  it('keeps the agent’s claude state writable during a run (it writes its own session)', () => {
    const plan = planRun(cfg({ grants: { claude: 'project' } }), facts(), ['x']);
    expect(find(plan.mounts, '/root/.claude')?.readonly).toBe(false);
  });
});

describe('planAdd', () => {
  it('leaves package.json writable but still locks persistence paths', () => {
    const plan = planAdd(cfg(), facts({ pm: 'pnpm', hasPackageJson: true }), ['is-number']);
    expect(find(plan.mounts, '/workspace/package.json')).toBeUndefined(); // inherits the writable root
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false);
    expect(find(plan.mounts, '/workspace/.github')?.readonly).toBe(true);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'add', '--save-exact', 'is-number']);
  });

  it('saves exact versions by default for every package manager add path', () => {
    expect(planAdd(cfg(), facts({ pm: 'npm' }), ['zod']).argv).toEqual(['npm', 'install', '--save-exact', 'zod']);
    expect(planAdd(cfg(), facts({ pm: 'pnpm' }), ['zod']).argv).toEqual(['corepack', 'pnpm', 'add', '--save-exact', 'zod']);
    expect(planAdd(cfg(), facts({ pm: 'yarn' }), ['zod']).argv).toEqual(['corepack', 'yarn', 'add', '--exact', 'zod']);
    expect(planAdd(cfg(), facts({ pm: 'bun' }), ['zod']).argv).toEqual(['bun', 'add', '--exact', 'zod']);
  });

  it('keeps an explicit yarn range modifier instead of forcing exact', () => {
    expect(planAdd(cfg(), facts({ pm: 'yarn' }), ['--tilde', 'zod']).argv).toEqual(['corepack', 'yarn', 'add', '--tilde', 'zod']);
  });
});

describe('planRemove', () => {
  it('drops a dep write-class like add: manifest writable, persistence locked, no exact defaulting', () => {
    const plan = planRemove(cfg(), facts({ pm: 'pnpm', hasPackageJson: true }), ['is-number']);
    expect(find(plan.mounts, '/workspace/package.json')).toBeUndefined(); // inherits the writable root
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false);
    expect(find(plan.mounts, '/workspace/.github')?.readonly).toBe(true);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'remove', 'is-number']);
    expect(plan.interactive).toBe(false);
  });

  it('uses each package manager’s drop verb, npm `uninstall`, others `remove`', () => {
    expect(planRemove(cfg(), facts({ pm: 'npm' }), ['lodash']).argv).toEqual(['npm', 'uninstall', 'lodash']);
    expect(planRemove(cfg(), facts({ pm: 'yarn' }), ['react']).argv).toEqual(['corepack', 'yarn', 'remove', 'react']);
    expect(planRemove(cfg(), facts({ pm: 'bun' }), ['left-pad']).argv).toEqual(['bun', 'remove', 'left-pad']);
  });
});

describe('frozen install', () => {
  it('npm: fully read-only source tree, runs npm ci', () => {
    const plan = planInstall(cfg(), facts({ pm: 'npm', hasPackageJson: true, hasLockfile: true }), [], { frozen: true });
    expect(plan.argv).toEqual(['npm', 'ci']);
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(true);
    expect(find(plan.mounts, '/workspace/node_modules')?.readonly).toBe(false);
    expect(find(plan.mounts, '/workspace/.github')).toBeUndefined(); // whole tree already ro
  });

  it('pnpm: keeps a writable root (it needs one) but locks the lockfile', () => {
    const plan = planInstall(cfg(), facts({ pm: 'pnpm', hasPackageJson: true, hasLockfile: true }), [], { frozen: true });
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'install', '--frozen-lockfile']);
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false);
    expect(find(plan.mounts, '/workspace/pnpm-lock.yaml')?.readonly).toBe(true);
    expect(find(plan.mounts, '/workspace/.github')?.readonly).toBe(true);
  });

  it('yarn berry uses --immutable', () => {
    expect(planInstall(cfg(), facts({ pm: 'yarn', isYarnBerry: true }), [], { frozen: true }).argv).toEqual(['corepack', 'yarn', 'install', '--immutable']);
  });

  it('bun: fully read-only source tree, runs bun install --frozen-lockfile', () => {
    const plan = planInstall(cfg(), facts({ pm: 'bun', hasPackageJson: true, hasLockfile: true }), [], { frozen: true });
    expect(plan.argv).toEqual(['bun', 'install', '--frozen-lockfile']);
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(true);
    expect(find(plan.mounts, '/workspace/node_modules')?.readonly).toBe(false);
  });
});

describe('planRun', () => {
  it('mounts the tree read-write and is interactive', () => {
    const plan = planRun(cfg(), facts(), ['node', 'x.js']);
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false);
    expect(plan.argv).toEqual(['node', 'x.js']);
    expect(plan.interactive).toBe(true);
  });

  it('drops ports when network is none, keeps them when on', () => {
    const ports = { run: { ports: ['8077:8077'] } };
    expect(planRun(cfg({ run: { network: 'none', ...ports.run } }), facts(), ['x']).ports).toEqual([]);
    const on = planRun(cfg({ run: { network: 'on', ...ports.run } }), facts(), ['x']);
    expect(on.ports).toEqual(['8077:8077']);
    expect(on.addHosts).toContain('host.docker.internal:host-gateway');
  });

  it('publishes common dev ports when devPorts is on (alongside explicit ports)', () => {
    const plan = planRun(cfg({ run: { network: 'on', devPorts: true, ports: ['9229:9229'] } }), facts(), ['x']);
    expect(plan.ports).toContain('5173:5173'); // vite
    expect(plan.ports).toContain('3000:3000'); // next/remix
    expect(plan.ports).toContain('9229:9229'); // explicit port preserved
  });

  it('never publishes dev ports when the network is none', () => {
    expect(planRun(cfg({ run: { network: 'none', devPorts: true } }), facts(), ['x']).ports).toEqual([]);
  });

  it('normalizes a bare or numeric port to HOST:CONTAINER (no random host port)', () => {
    expect(planRun(cfg({ run: { network: 'on', ports: ['4321'] } }), facts(), ['x']).ports).toEqual(['4321:4321']);
    expect(planRun(cfg({ run: { network: 'on', ports: [3000] } }), facts(), ['x']).ports).toEqual(['3000:3000']);
  });

  it('publishes override.ports over plan.ports when execute narrows them to the free set', () => {
    const plan = planRun(cfg({ run: { network: 'on', ports: ['3000:3000', '8080:8080'] } }), facts(), ['x']);
    const args = renderRunArgs(plan, { ports: ['3000:3000'] });
    expect(args.filter((a, i) => args[i - 1] === '-p')).toEqual(['3000:3000']);
  });
});

describe('grants', () => {
  it('forwards the ssh agent socket and sets SSH_AUTH_SOCK', () => {
    const plan = planRun(cfg({ grants: { 'ssh-agent': true } }), facts(), ['x']);
    expect(find(plan.mounts, '/ssh-agent')).toBeTruthy();
    expect(plan.env.SSH_AUTH_SOCK).toBe('/ssh-agent');
  });

  it('mounts a project-scoped claude dir at /root/.claude', () => {
    const plan = planRun(cfg({ grants: { claude: 'project' } }), facts(), ['x']);
    expect(find(plan.mounts, '/root/.claude')?.source).toBe(path.join(CWD, '.claude-sandbox'));
  });

  it('expands a home Claude grant against the probed homedir', () => {
    const plan = planRun(cfg({ grants: { claude: 'home' } }), facts({ homedir: '/home/dev' }), ['x']);
    expect(find(plan.mounts, '/root/.claude')?.source).toBe('/home/dev/.claude');
  });

  it('parses path specs (ro default, rw opt-in, ~ expansion)', () => {
    const plan = planRun(cfg({ grants: { paths: ['./data:rw', './secrets', '~/keys'] } }), facts({ homedir: '/home/dev' }), ['x']);
    expect(find(plan.mounts, '/grants/data')?.readonly).toBe(false);
    expect(find(plan.mounts, '/grants/secrets')?.readonly).toBe(true);
    expect(find(plan.mounts, '/grants/keys')?.source).toBe('/home/dev/keys'); // ~ expands against facts.homedir
  });

  it('passes named env vars from the host only when present', () => {
    const plan = planRun(cfg({ grants: { env: ['MY_TOKEN', 'ABSENT'] } }), facts({ hostEnv: { MY_TOKEN: 'abc' } }), ['x']);
    expect(plan.env.MY_TOKEN).toBe('abc');
    expect(plan.env.ABSENT).toBeUndefined();
  });

  it('injects env-file values, with named host env vars taking precedence', () => {
    const plan = planRun(cfg({ grants: { env: ['API_URL'] } }), facts({
      hostEnv: { API_URL: 'http://host' },
      envFileValues: { API_URL: 'http://file', FEATURE_FLAG: 'true' },
    }), ['x']);
    expect(plan.env.FEATURE_FLAG).toBe('true');
    expect(plan.env.API_URL).toBe('http://host'); // explicit host grant overrides the env file
  });
});

describe('renderRunArgs', () => {
  it('renders binds, ro-volumes, env, security, and an explicit network', () => {
    const plan = planInstall(cfg(), facts({ hasPackageJson: true }), []);
    const args = renderRunArgs(plan, { network: 'none' });
    const joined = args.join(' ');
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
    expect(joined).toContain('--network none');
    expect(joined).toContain('type=bind,source='); // binds use --mount, not -v
    expect(joined).toContain('target=/workspace/package.json,readonly'); // manifest locked
    expect(joined).toContain('type=volume,target=/workspace/.github,readonly'); // missing vector blocked
    expect(args).not.toContain('-v'); // never the colon-splitting short form (Windows-safe)
    expect(args[args.length - 2]).toBe('npm'); // image precedes argv
  });

  it('renders a Windows host path intact (drive-letter colon is not split)', () => {
    const plan = planRun(cfg({ run: { network: 'on' } }), facts({ cwd: 'C:\\Users\\dev\\proj' }), ['npm', 'run', 'dev']);
    const args = renderRunArgs(plan);
    expect(args).toContain('type=bind,source=C:\\Users\\dev\\proj,target=/workspace');
    expect(args).not.toContain('-v');
  });

  it('merges egress proxy env supplied at run time', () => {
    const plan = planInstall(cfg(), facts(), []);
    const args = renderRunArgs(plan, { network: 'sbx_int_x', extraEnv: { HTTP_PROXY: 'http://p:8888' } });
    expect(args.join(' ')).toContain('HTTP_PROXY=http://p:8888');
    expect(args.join(' ')).toContain('--network sbx_int_x');
  });

  it('bridge mode ("on") adds the metadata guard: net caps + guard entrypoint', () => {
    const plan = planRun(cfg({ run: { network: 'on' } }), facts(), ['npm', 'run', 'dev']);
    const args = renderRunArgs(plan); // no override.network == default bridge, the "on" path
    const joined = args.join(' ');
    expect(joined).toContain('--cap-add NET_ADMIN');
    expect(joined).toContain('--cap-add SETPCAP');
    const gi = args.indexOf('--entrypoint');
    expect(args[gi + 1]).toBe('/usr/local/bin/sbx-net-guard');
    expect(gi).toBeLessThan(args.indexOf(plan.image)); // the entrypoint flag precedes the image
  });

  it('isolated and proxy modes do NOT add the metadata guard (no host route to block)', () => {
    const plan = planInstall(cfg(), facts(), []);
    for (const network of ['none', 'sbx_int_x']) {
      const joined = renderRunArgs(plan, { network }).join(' ');
      expect(joined).not.toContain('NET_ADMIN');
      expect(joined).not.toContain('sbx-net-guard');
    }
  });
});

describe('CI env (non-interactive install containers)', () => {
  it('marks install/add/update/audit-fix plans as CI so pnpm never aborts on a no-TTY purge', () => {
    expect(planInstall(cfg(), facts({ pm: 'pnpm' })).env.CI).toBe('1');
    expect(planAdd(cfg(), facts({ pm: 'pnpm' }), ['zod']).env.CI).toBe('1');
    expect(planUpdate(cfg(), facts({ pm: 'pnpm' }), ['pnpm', 'up']).env.CI).toBe('1');
    expect(planAuditFix(cfg(), facts({ pm: 'pnpm' }), ['pnpm', 'audit', '--fix']).env.CI).toBe('1');
  });

  it('leaves interactive run/dev plans non-CI so a real TTY can still drive prompts', () => {
    expect(planRun(cfg(), facts(), ['test']).env.CI).toBe('');
  });
});
