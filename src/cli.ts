#!/usr/bin/env node
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { confirm, isCancel, spinner } from '@clack/prompts';
import type { SandboxConfig } from './config.js';
import { loadConfig, readConfig, setLocalOff } from './config.js';
import { resolveProjectContext } from './context.js';
import { renderBadge } from './badge.js';
import { COMPLETION_SHELLS, completionScript, isCompletionShell } from './completion.js';
import { runAuditVerify, runKeygen, runVerify, runVerifyReceipt, readSigningKey, signVerifyReceipt } from './verify.js';
import { effectivePm, isGlobalInstall, routePassthrough, unwrapSelfInvocation, type Route } from './dispatch.js';
import { runDoctor } from './doctor.js';
import { findPendingBuilds, writeBuildApprovals } from './build-approval.js';
import { ensureLocalConfigIgnored, runInit } from './init.js';
import { log } from './log.js';
import { lockfileName, pmExecArgv, pmScriptArgv, resolvePackageManager, type PackageManager } from './package-manager.js';
import { probeProject, readManifestDependencies, readWorkspaceDependencies, type ProjectFacts } from './project.js';
import { foldBinLeader, leaderForBin } from './native.js';
import { allowHosts } from './registry.js';
import { type AdvisoryHit, type AdvisorySeverityCounts, highestSeverity } from './advisory.js';
import { blockExit, deprecatedHints, nothingToCheck, type ActivePolicy } from './gates.js';
import { runPreflight, suggestPins, type PinSuggestion, type PreflightPolicy, type PreflightResult } from './preflight.js';
import { runScan } from './scan.js';
import { runDelta } from './delta.js';
import { feedCacheDir, loadKnownBad, PROJECT_ADVISORY_NAME, updateFeeds, type KnownBadHit } from './known-bad.js';
import { scanSecrets, type SecretFinding } from './secrets.js';
import { formatSafeReceipt, freshSubstitutions, incidentallyPinned, rewriteAddArgs, type Substitution } from './safe-install.js';
import { applyUpgrades, classifyUpgrades, defaultNcuRunner, mergeProposals, NCU_SPEC, ncuPasses, parseUpgrades, readDeclaredRanges, renderUpgradeTable, upgradeTargets, type NcuRunner, type ProposedUpgrade, type UpgradePolicy, type UpgradeTarget } from './upgrade.js';
import { execPackageTargets, parseLockfilePackages, parsePackageTargets, planRiskHintLog, riskTargetsForInstall, riskTargetsForUpdate, type LockfilePackage, type ReleaseAgeViolation, type RiskHint, type RiskTarget } from './risk.js';
import { runSetup } from './setup.js';
import { buildHostSuffixes } from './hosts.js';
import { disabledByEnv, refreshUpdateCache, scheduleUpdateCheck, selfVersion, updateBanner } from './update-check.js';
import { fail } from './fail.js';
import type { Globals } from './globals.js';
import { resolvedFrozen, routeToHostArgv, runWrite, type PlanOptions, type WriteContext } from './write.js';

const HELP = `screen: supply-chain gates first, install natively. A fast filter, not a cage.

Usage: screen [globals] <command> [args]

Quick start:
  screen check zod            review a package before you add it (no install)
  screen install              vet, then install natively with the detected package manager
  screen add zod              vet, then add a dependency natively
  screen update               vet, then update dependencies natively
  screen pnpm add zod         vet, then install natively (explicit package manager)

How it works: every install/add/update/remove runs the supply-chain gates (OSV malware advisories,
your malware feeds + team advisories, typosquats, the release-age worm window, deprecation) BEFORE
anything is fetched, then installs natively on the host so your IDE and tools just work. A native
install runs lifecycle scripts on the host, so the gates are heuristic screening, not a hard
boundary; for a real boundary, run untrusted installs in your own isolated environment.

Common project commands:
  screen dev                  auto-detect PM, run dev/start/serve
  screen test                 auto-detect PM, run a package.json script natively
  screen script build         run a specific package.json script, even if it collides with a screen command
  screen setup --vibe         one-button setup for vibe/dev work

Expert: per-PM binaries (same gated native path, shorter keystrokes)
  New here? Use \`screen add\` / \`screen install\` above. These are for muscle memory only:
  screen-pnpm add zod          vet with the gate engine, then install natively.
  (short alias: spnpm)         Same for npm/yarn/bun. Your real \`pnpm\` is never touched.
  screen-npm/snpm · screen-yarn/syarn · screen-bun/sbun · screen-npx/snpx · screen-bunx/sbunx

Advanced commands:
  init [--preset N]    create screen.config.json from a preset (interactive picker,
                       or non-interactive with --preset strict|balanced|vibe|agent|trusted [--force])
  setup [--preset N]   one-button onboarding: write config if needed, then print the next commands
  dev                  auto-detect the package manager and run the first of
                       dev > start > serve from package.json. Passes through extra args.
  script <name>        run the named package.json script with native PM syntax.
                       Use this when the script name collides with a screen command
                       like scan/doctor.
  allow <host...>      add host(s) to egress.allow in screen.config.json
  off / on             toggle the screen wrapper for this project (writes off to screen.config.local.json,
                       your git-ignored personal override). off → screen commands pass straight through
                       on the host here; on → gates + normal screen behavior again. The per-project twin of SCREEN_OFF=1.
  completion <shell>   print a standalone tab-completion script for zsh|bash|fish (commands,
                       globals, --preset/--risk). Install it for zsh, e.g.:
                       \`screen completion zsh > "\${fpath[1]}/_screen"\`.
  approve-builds [pkg]  approve dependency build scripts pnpm left ignored (writes allowBuilds +
                       onlyBuiltDependencies, then re-installs). No args = approve all pending;
                       --deny records the opposite. Install also prompts on a TTY automatically.
  check [pkg... | file.json | pm cmd]   audit packages BEFORE you install them. A read-only review pass.
                       Queries the registry + OSV advisory DB and prints
                       every finding (malware, vulns, typosquats, fresh/deprecated versions, …).
                         screen check express lodash@4      bare names (the common case)
                         screen check                       this project's deps (root + every workspace)
                         screen check ./apps/web/package.json   the deps in a specific manifest
                         screen check npm install x         a full command form
                       A package.json is read workspace-aware, so a monorepo root expands to all of
                       its packages. Blocks on malware/known-bad; --min-release-age / --fail-on-advisory
                       / --fail-on-risk tighten it for CI.
  preflight [pm cmd]   alias of check that mirrors a specific install command's gates.
  scan                 RETROACTIVE malware sweep: re-query OSV for the versions in your committed
                       lockfile and exit non-zero if any installed package is NOW flagged as
                       malware. Catches deps that turned malicious AFTER you installed them, the
                       gap install-time gating can't cover. Run in CI/cron.
  delta [--base <ref>] gate ONLY the dependency changes a PR introduces: diff the lockfile against
                       <ref> (default origin/main; or --base-lockfile <path>) and run the release-age,
                       malware, and deprecation gates over just the added/bumped versions. Honors
                       --min-release-age / --fail-on-advisory. Fast, low-noise PR check.
  secrets [path]       offline scan for committed credentials (API keys, tokens, private keys, db
                       URLs). Read-only; exits non-zero on any finding (CI tripwire).
                       Matched values are redacted. Reports where, never the secret. Defaults to cwd.
                       ~40 provider patterns, checksum/decode validation (Luhn, JWT) to cut noise,
                       plus an entropy fallback for secret-ish values with no known shape.
  feeds <update|list>  manage malware FEEDS (install.malwareFeeds): \`update\` fetches + caches them so
                       the install-time blocklist check stays offline; \`list\` shows configured/cached
                       feeds. A package on a feed (or in screen.advisories.json) ALWAYS blocks installs.
  upgrade [--write]    move declared dependency RANGES to newer versions (npm-check-updates),
                       NOT just within the range (that's \`screen npm update\`). Your release-age
                       gate drives ncu's --cooldown automatically, the proposed versions go through
                       the SAME gates as install, and --write rewrites package.json then installs.
                       --minor/--patch/--target to cap the jump; --reject <pat> to skip.
  doctor               check config, package manager, registry hosts, and Node runtime state.
  verify [--scan]      exit non-zero unless this repo commits a real screen boundary and
       [--secrets]     no personal layer has loosened it, the CI gate behind the badge.
       [--sign]        --scan also runs the retroactive malware sweep (so the badge means
                       "boundary intact AND no installed dep is currently flagged as malware");
                       --secrets also fails if a credential is committed in the repo;
                       --sign emits an Ed25519-signed receipt of the green boundary to stdout
                       (needs SCREEN_SIGNING_KEY → a key file from \`screen keygen\`)
  verify-receipt <f>   verify a signed receipt from \`verify --sign\`; --fingerprint <hex> (or
                       SCREEN_TRUSTED_KEY) pins the signer so any other key is rejected
  keygen               generate an Ed25519 signing keypair: private key → CI secret
                       (SCREEN_SIGNING_KEY), fingerprint → pin via SCREEN_TRUSTED_KEY
  audit verify <log>   verify the hash-chained audit log is intact (no entry altered or removed).
                       Set SCREEN_AUDIT_LOG=<path> on any run to append tamper-evident events
  badge [--workflow F] print a markdown "screened" badge. Bare = static provenance badge;
                       --workflow screen.yml = the CI-backed verified badge (--repo to override)

Pass-through and expert commands:
  install [pm-args]    vet, then install deps natively with the detected package manager.
  add <pkg...>         add dependency(ies); writes package.json, saved as exact versions
                       by default
  remove <pkg...>      drop dependency(ies); writes package.json like add, but fetches
                       nothing new (no supply-chain gate). Pass-through too: screen npm
                       uninstall lodash · screen pnpm remove zod · screen bun rm left-pad
  x <tool> [args]      run a package binary npx/bunx-style (local-first, fetches as fallback),
                       the shorthand for screen npx <tool> / screen bunx <tool>
  run -- <cmd...>      run a command natively on the host
  version              print the installed screen version (also -v / --version)

Expert: explicit package-manager passthrough still works: \`screen npm install\`,
\`screen pnpm add zod\`, \`screen yarn upgrade\`, \`screen bunx vite\`.

Globals (before the command):
  --config <path>      use a specific screen.config.json
  --env <NAME>         forward one host env var by name for this invocation
  --env-from <path>    parse one env file on the host and inject its values; append
                       :KEY1,KEY2 to inject only those keys (e.g. .env:FOO,BAR).
                       Named --env-from because Node ≥20.6 reserves --env-file.
  --frozen             reproducible install (npm ci / --frozen-lockfile). Needs a committed lockfile.
  --fail-on-source-writes  exit non-zero if an install edited your source tree outside deps/lockfiles
                       (a tripwire after the fact: the tree is writable, so review with git diff)
  --risk <off|basic|thorough>  registry risk hints: off; basic (packument-only: typosquat,
                       provenance regression, maintainer takeover, …); thorough adds
                       network checks (missing metadata, low downloads, expired domains)
  --fail-on-risk       exit non-zero when risk hints are found (blocks before running)
  --min-release-age <days>   BLOCK installing any version published fewer than <days> ago
                       (overrides config; 0 disables). The strongest control against
                       publish-and-detonate supply-chain worms. The strict preset sets 7.
  --allow-recent <pat> exempt a package-name pattern from the release-age gate (repeatable;
                       globs allowed, e.g. @myscope/*). Merges with install.minReleaseAgeExclude.
  --deep               extend the blocking gates (release-age, deprecated, and malware when
                       --fail-on-advisory is set) to the whole resolved tree (transitive),
                       read from the lockfile (npm + pnpm + yarn), not just direct deps
  --fail-on-advisory   BLOCK when a version is flagged as malware in the OSV advisory DB
                       (the strict preset sets this)
  --allow-deprecated   allow installing a maintainer-DEPRECATED version (off by default:
                       deprecated versions are abandoned and a supply-chain risk, so they
                       are blocked). Rides on risk hints, so --risk off also disables it.
  --allow-all-builds   approve every ignored dependency build script without prompting (CI/agents)
  --allow-build-hosts  widen egress.allow (this run) to the curated native-build/release hosts:
                       Node headers, GitHub releases, Prisma/Playwright/Cypress/Electron binaries
  --dry-run            print what would run natively; then stop (human-readable)
  --json               print what would run as JSON instead of running it
  --no-update-check    skip the once-a-day "new version available" check for this run
                       (also off via NO_UPDATE_NOTIFIER=1, CI=1, or updateCheck:false in config)

Turn it off: SCREEN_OFF=1 runs one command (or, exported, a whole shell) straight on the host with
no screening. For a trusted repo, set "off": true in screen.config.json (whole team) or
screen.config.local.json (just you). Screen-only commands (check, doctor, init, verify, …) keep
working either way.

Logging: human lines on stderr by default; set SCREEN_LOG=json for NDJSON,
SCREEN_LOG_LEVEL=debug|info|warn|error to filter.
`;

/** Parse global flags that appear BEFORE the command (so they never clash with `run --`). */
function parse(argv: string[]): { globals: Globals; cmd?: string; args: string[] } {
  const globals: Globals = {
    json: false,
    frozen: false,
    dev: false,
    failOnEgress: false,
    failOnSourceWrites: false,
    fullNetwork: false,
    envNames: [],
    envFiles: [],
    dryRun: false,
    allowRecent: [],
    deep: false,
    interactive: false,
    noUpdateCheck: false,
    allowBuildHosts: false,
    allowAllBuilds: false,
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') globals.config = argv[++i];
    else if (a === '--json') globals.json = true;
    else if (a === '--format') {
      const f = argv[++i];
      if (f === 'json') globals.json = true; // --format json is an alias for --json
      else if (f === 'agent' || f === 'ai') globals.format = 'agent';
      else if (f === 'human' || f === 'text') globals.format = 'human';
      else fail(`--format needs json, agent, or human (got '${f ?? ''}')`);
    }
    else if (a === '--env') globals.envNames.push(argv[++i] ?? '');
    else if (a === '--env-from' || a === '--env-file') globals.envFiles.push(argv[++i] ?? ''); // --env-file kept as a legacy alias; Node ≥20.6 reserves it, so --env-from is preferred
    else if (a === '--dev') globals.dev = true;
    else if (a === '--frozen') globals.frozen = true;
    else if (a === '--fail-on-egress') globals.failOnEgress = true;
    else if (a === '--fail-on-source-writes') globals.failOnSourceWrites = true;
    else if (a === '--risk') {
      const v = argv[++i];
      globals.risk = v === 'off' ? 'off' : v === 'thorough' ? 'thorough' : 'basic';
    }
    else if (a === '--fail-on-risk') globals.failOnRisk = true;
    else if (a === '--full-network') globals.fullNetwork = true;
    else if (a === '--dry-run') globals.dryRun = true;
    else if (a === '--min-release-age') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) fail(`--min-release-age needs a non-negative whole number of days (got '${raw ?? ''}')`);
      globals.minReleaseAge = n;
    } else if (a === '--allow-recent') globals.allowRecent.push(argv[++i] ?? '');
    else if (a === '--deep') globals.deep = true;
    else if (a === '--interactive' || a === '--prompt') globals.interactive = true;
    else if (a === '--fail-on-advisory') globals.failOnAdvisory = true;
    else if (a === '--allow-deprecated') globals.failOnDeprecated = false;
    else if (a === '--canaries') globals.canaries = true;
    else if (a === '--no-canaries') globals.canaries = false;
    else if (a === '--no-update-check') globals.noUpdateCheck = true;
    else if (a === '--allow-build-hosts') globals.allowBuildHosts = true;
    else if (a === '--allow-all-builds') globals.allowAllBuilds = true;
    else break;
  }
  return { globals, cmd: argv[i], args: argv.slice(i + 1) };
}

/**
 * One-off invocation modes, applied to the config for this run only:
 * `--allow-build-hosts` widens the egress allowlist to the curated native-build/release hosts;
 * `--dev` / `--full-network` are kept for surface compatibility but no longer change containment
 * (every command runs natively on the host now).
 */
function applyOneOffModes(config: SandboxConfig, globals: Globals): SandboxConfig {
  let cfg = config;
  if (globals.allowBuildHosts) {
    const extra = buildHostSuffixes().filter((h) => !cfg.egress.allow.includes(h));
    if (extra.length) cfg = { ...cfg, egress: { ...cfg.egress, allow: [...cfg.egress.allow, ...extra] } };
  }
  if (!globals.dev && !globals.fullNetwork) return cfg;
  const run = { ...cfg.run, network: 'on' as const };
  if (!globals.fullNetwork) return { ...cfg, run };
  return { ...cfg, install: { ...cfg.install, network: 'on' }, run };
}

/**
 * Containment turned OFF — by `off: true` in the config (team or personal-local) or a non-empty
 * `SCREEN_OFF` env var. When off, operation commands run straight on the host. Mirrors the shell
 * wrappers' `[ -n "$SCREEN_OFF" ]` test so one knob means the same thing everywhere.
 */
function sandboxOff(config: SandboxConfig): boolean {
  return config.off || (process.env.SCREEN_OFF ?? '') !== '';
}

/**
 * Run the resolved command on the host (no screening), inheriting stdio so an interactive install/dev
 * server behaves exactly as if the wrapper weren't there. `--dry-run` and `--json` describe the host
 * command instead of running it. `notice` says why we're bypassing screening (off, or a global install).
 */
function execOnHost(argv: string[], cwd: string, globals: Globals, notice: string): number {
  if (globals.dryRun) {
    console.log(`screen: ${notice}, would run on the host:\n  ${argv.join(' ')}`);
    return 0;
  }
  if (globals.json) {
    console.log(JSON.stringify({ host: true, notice, argv }, null, 2));
    return 0;
  }
  log.warn(`${notice}. Running on the host: ${argv.join(' ')}`);
  const [program, ...rest] = argv;
  const result = spawnSync(program!, rest, { cwd, stdio: 'inherit' });
  if (result.error) fail(`could not run '${program}' on the host: ${result.error.message}`);
  return result.status ?? 1;
}

/** The host runner for "screening off" (config `off:true` or SCREEN_OFF). */
function runOnHost(argv: string[], cwd: string, globals: Globals): number {
  return execOnHost(argv, cwd, globals, `screening is off (${config_off_reason()})`);
}

/** Why screening is off, for the one-line notice — the env var wins the attribution when both are set. */
function config_off_reason(): string {
  return (process.env.SCREEN_OFF ?? '') !== '' ? 'SCREEN_OFF' : 'off:true in config';
}

/**
 * The exact command to run on the host when containment is off. A pass-through leader
 * (`sandbox npm ci`, `sandbox pnpm add zod`, `sandbox npx vite`) runs VERBATIM — truest to "as if
 * sandbox weren't in front of it", preserving `ci`/flags and the host's own package manager. A
 * sandbox shorthand (`dev`, `test`, `install`, `add`, `remove`, `x`, …) uses its resolved argv, honouring
 * `--frozen` (reproducible argv) so `SCREEN_OFF=1 sandbox --frozen install` matches the contained path.
 */
function hostCommandFor(cmd: string, args: string[], route: Route, frozen: boolean, yarnBerry: boolean): string[] {
  if (routePassthrough([cmd, ...args])) return [cmd, ...args];
  return routeToHostArgv(route, { frozen, yarnBerry });
}

/**
 * Every plan-producing command reduces to one of three containment models. The explicit
 * subcommands (`install`/`add`/`run`/`shell`) and the transparent `sandbox <npm|pnpm|yarn|
 * npx|…>` pass-through all resolve here, so risk-checking and planning happen once, in one
 * place, instead of being re-derived per command. Bad input and unknown commands `fail()`.
 */
function resolveRoute(cmd: string, args: string[], facts: ProjectFacts): Route | undefined {
  switch (cmd) {
    case 'install':
      return { model: 'install', pm: facts.pm, frozen: false, args };
    case 'add':
      if (args.length === 0) fail('usage: screen add <pkg>...  (deliberate package.json change)');
      return { model: 'add', pm: facts.pm, pkgs: args };
    case 'remove':
      if (args.length === 0) fail('usage: screen remove <pkg>...  (deliberate package.json change)');
      return { model: 'remove', pm: facts.pm, pkgs: args };
    case 'script': {
      const [script, ...rest] = args;
      if (!script) fail('usage: screen script <name> [args]');
      return { model: 'run', argv: pmScriptArgv(facts.pm, script, rest) };
    }
    case 'run': {
      const argv = args[0] === '--' ? args.slice(1) : args;
      if (argv.length === 0) fail('usage: screen run -- <cmd...>');
      return { model: 'run', argv };
    }
    case 'x': {
      // The npx/bunx muscle-memory shortcut: `screen x vite` runs the local (or fetched) tool.
      if (args.length === 0) fail('usage: screen x <tool> [args]  (run a package binary, npx-style)');
      return { model: 'run', argv: pmExecArgv(facts.pm, args) };
    }
    default: {
      // Transparent pass-through: `sandbox npm install`, `sandbox pnpm add zod`, `sandbox npm run dev`.
      return routePassthrough([cmd, ...args]);
    }
  }
}

/**
 * Resolve a command against the sandbox subcommands, passthrough PM/runners, and package.json
 * scripts. Scripts are the generic fallback: `sandbox test`, `sandbox lint`, `sandbox typecheck`,
 * etc. `dev` is just one script-shaped command that prefers `dev -> start -> serve`; its only other
 * semantic — dev-mode networking — lives in `main()`, where `sandbox dev` folds into `globals.dev`
 * so there is one effective config (see {@link applyOneOffModes}).
 */
function resolveCommand(cmd: string, args: string[], facts: ProjectFacts): Route {
  const route = resolveRoute(cmd, args, facts);
  if (route) return route;
  if (cmd === 'dev') {
    const scriptName = ['dev', 'start', 'serve'].find((s) => s in facts.scripts);
    if (!scriptName) fail('no "dev", "start", or "serve" script found in package.json');
    return { model: 'run', argv: pmScriptArgv(facts.pm, scriptName, args) };
  }
  if (facts.scripts[cmd]) return { model: 'run', argv: pmScriptArgv(facts.pm, cmd, args) };
  fail(`unknown command '${cmd}'\n  try a command you know:  screen install · screen add zod · screen dev · screen x vite\n  or a screen command:     init · setup · allow · check · doctor · build · install · add · remove · script · run · x · shell`);
}

/**
 * The dependencies declared in a `package.json` (or any manifest-shaped `.json`) handed to `check`.
 * A file literally named `package.json` is read workspace-aware, so pointing at a monorepo root
 * expands every workspace package too — the same union `check` with no args audits. `name@spec`
 * tokens flow through the add surface, where local `workspace:`/`file:` specs are dropped.
 */
function depsFromManifestArg(file: string, cwd: string): string[] {
  const abs = path.resolve(cwd, file);
  if (!existsSync(abs)) fail(`check: no such file '${file}'`);
  const deps = path.basename(abs) === 'package.json' ? readWorkspaceDependencies(path.dirname(abs)) : readManifestDependencies(abs);
  return deps.map((d) => `${d.name}@${d.spec}`);
}

/**
 * The route `sandbox check`/`preflight` should audit. Friendly ergonomics: a `.json` file argument
 * audits the dependencies declared in that manifest (`check ./packages/api/package.json`, monorepo
 * roots expand to every workspace); bare package names are the common case (`check express lodash@4`
 * → an add surface); a leading package manager means the caller spelled the whole command (`check npm
 * install x`); and no args audits the current project's manifest(s) — root plus every workspace.
 *
 * `invocationCwd` is the directory the user actually ran from (NOT the probed project root), so a
 * relative `.json` path resolves where they'd expect from a workspace subdirectory.
 */
function checkRouteFor(args: string[], facts: ProjectFacts, invocationCwd: string): Route {
  const manifests = args.filter((a) => a.endsWith('.json'));
  if (manifests.length) {
    const pkgs = manifests.flatMap((file) => depsFromManifestArg(file, invocationCwd));
    if (!pkgs.length) fail(`check: no registry dependencies found in ${manifests.join(', ')}`);
    return { model: 'add', pm: facts.pm, pkgs };
  }
  if (args.length === 0) return resolveCommand('install', [], facts);
  if (args[0] === 'npm' || args[0] === 'pnpm' || args[0] === 'yarn' || args[0] === 'bun') {
    return resolveCommand(args[0], args.slice(1), facts);
  }
  return { model: 'add', pm: facts.pm, pkgs: args };
}

/**
 * Emit the registry risk-hint report. The decision (what to print, at what level, and the
 * invisible-when-clean behaviour) lives in {@link planRiskHintLog} so it stays testable; this just
 * routes each line to the matching logger method.
 */
function logRiskHints(targets: RiskTarget[], allHints: RiskHint[], opts: { contained: boolean; pm?: PackageManager } = { contained: true }): void {
  for (const { level, text } of planRiskHintLog(targets.length, allHints, opts)) log[level](text);
}

/**
 * The packages a route would pull from the registry — the supply-chain surface to check:
 * `add`/`install` look at the named (or lockfile-pinned) deps; `run` looks only at what a
 * fetch-and-run command (`npx`/`dlx`/`bunx`/`npm exec`) would fetch, so running your own
 * code (`node`, `vite`, a script) yields nothing.
 */
function riskTargetsForRoute(route: Route, facts: ProjectFacts): RiskTarget[] {
  switch (route.model) {
    case 'add':
      return parsePackageTargets(route.pkgs);
    case 'install': {
      const named = parsePackageTargets(route.args);
      return named.length ? named : riskTargetsForInstall(facts);
    }
    case 'update': {
      const latest = route.args.some((a) => a === '--latest' || a === '-L');
      const names = parsePackageTargets(route.args).map((t) => t.name);
      return riskTargetsForUpdate({ ...facts, pm: route.pm }, names, latest);
    }
    case 'auditFix':
      return riskTargetsForUpdate({ ...facts, pm: route.pm }, parsePackageTargets(route.args).map((t) => t.name), false);
    case 'remove':
    case 'audit':
    case 'auditSignatures':
      return []; // removal/read-only verification fetch nothing new, so there's no supply-chain surface to gate
    case 'run':
      return execPackageTargets(route.argv);
  }
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * Whether the gated targets are EXISTING dependencies (a bare install/update reproducing the
 * manifest/lockfile) rather than packages being added. When true, an age block is usually noise —
 * the versions are already committed — so we steer to `sandbox delta`, which gates only what a change
 * introduces.
 */
function gatingExistingDeps(route: Route): boolean {
  if (route.model === 'install') return parsePackageTargets(route.args).length === 0;
  return route.model === 'update' || route.model === 'auditFix';
}

function logReleaseAgeBlock(violations: ReleaseAgeViolation[], minDays: number, pm: PackageManager, suggestions: PinSuggestion[], reproduce = false): void {
  const pin = new Map(suggestions.map((s) => [s.name, s]));
  const lines = [
    `blocked by the release-age gate (min ${minDays} day${minDays === 1 ? '' : 's'})`,
    ...violations.map((v) => {
      const s = pin.get(v.name);
      const tail = s ? `\n    ↳ pin a known-good version: screen ${pm} add ${v.name}@${s.version} (published ${formatAge(s.ageMs)})` : '';
      return `  ${v.name}@${v.version} was published ${formatAge(v.ageMs)}${tail}`;
    }),
    'freshly-published versions are the supply-chain worm window. Options:',
    // For a bare reproduce-the-lockfile install, the right tool is the delta gate — lead with it.
    ...(reproduce ? ['  • these are existing dependencies, not new ones, review only what a change introduces: `screen delta` (diffs the lockfile against origin/main, skipping versions already committed)'] : []),
    suggestions.length ? '  • pin the suggested older version above' : '  • pin a known-good older version',
    '  • wait until it ages past the threshold, then retry',
    '  • override this once: add --min-release-age 0 before the command',
  ];
  log.error(lines.join('\n'));
}

function logAdvisoryHits(hits: AdvisoryHit[]): void {
  if (!hits.length) return;
  const grouped = new Map<string, AdvisoryHit[]>();
  for (const hit of hits) {
    const list = grouped.get(hit.name) ?? [];
    list.push(hit);
    grouped.set(hit.name, list);
  }
  // Sort by worst-first: malware > critical > high > moderate > low, then alphabetically
  const severityOf = (name: string): number => {
    const g = grouped.get(name)!;
    if (g.some((h) => h.malware)) return 0;
    const sev = highestSeverity(g.flatMap((h) => h.advisories ?? []));
    return sev === 'critical' ? 1 : sev === 'high' ? 2 : sev === 'moderate' ? 3 : 4;
  };
  const entries = [...grouped.entries()].sort(([a], [b]) => severityOf(a) - severityOf(b) || a.localeCompare(b));
  const hasMalware = (name: string) => grouped.get(name)!.some((h) => h.malware);
  const fmtIds = (h: AdvisoryHit): string => {
    const ids = h.ids.length <= 4 ? h.ids.join(', ') : `${h.ids.slice(0, 4).join(', ')}, … (+${h.ids.length - 4})`;
    const sev = highestSeverity(h.advisories ?? []);
    const tag = h.direct ? ' [direct]' : h.direct === false ? ' [transitive]' : '';
    const sevLabel = sev ? ` ${sev}` : '';
    return `${ids}${sevLabel}${tag}`;
  };
  for (const [name, group] of entries) {
    const level = hasMalware(name) ? 'error' : 'warn';
    const label = hasMalware(name) ? 'KNOWN MALWARE' : 'advisory';
    if (group.length === 1) {
      const h = group[0]!;
      log[level](`${h.name}@${h.version}, ${label} ${fmtIds(h)}`);
    } else {
      const header = `${name} (${group.length} version${group.length === 1 ? '' : 's'})`;
      const items = group.sort((a, b) => a.version.localeCompare(b.version)).map((h) => `  ${h.version}, ${fmtIds(h)}`);
      log[level]([header, ...items].join('\n'));
    }
  }
}

function logScanSummary(counts: AdvisorySeverityCounts, totalPackages: number, scanned: number, triaged: number): void {
  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.high) parts.push(`${counts.high} high`);
  if (counts.moderate) parts.push(`${counts.moderate} moderate`);
  if (counts.low) parts.push(`${counts.low} low`);
  if (!parts.length) return;
  const triageNote = triaged ? ` (${triaged} triaged)` : '';
  log.warn(`scan: ${parts.join(', ')} across ${totalPackages} package(s)${triageNote} (${scanned} scanned)`);
}

/** Generate an actionable fix line for a package. */
function formatFixLine(name: string, hit: AdvisoryHit, pm: PackageManager): string | undefined {
  if (hit.malware) {
    return `  → ${pm} remove ${name}@${hit.version}, flagged as malware`;
  }
  // Gather fix versions across all advisories (earliest >= current stable version wins)
  let bestFix: string | undefined;
  let bestParts: number[] | undefined;
  const parseVer = (v: string): number[] | undefined => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
    return m ? [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)] : undefined;
  };
  const currentParts = parseVer(hit.version);
  for (const d of hit.advisories ?? []) {
    for (const fv of d.fixedVersions ?? []) {
      const parts = parseVer(fv);
      if (!parts) continue; // skip pre-releases and non-semver versions
      if (currentParts && (parts[0]! < currentParts[0]! || (parts[0] === currentParts[0] && parts[1]! < currentParts[1]!) || (parts[0] === currentParts[0] && parts[1] === currentParts[1] && parts[2]! <= currentParts[2]!))) continue;
      if (!bestParts || parts[0]! < bestParts[0]! || (parts[0] === bestParts[0] && parts[1]! < bestParts[1]!) || (parts[0] === bestParts[0] && parts[1] === bestParts[1] && parts[2]! < bestParts[2]!)) {
        bestFix = fv;
        bestParts = parts;
      }
    }
  }
  if (!bestFix) return undefined;
  if (hit.direct) {
    return `  → screen ${pm} update ${name}  (fix: ${bestFix})`;
  }
  // Transitive: suggest overrides
  switch (pm) {
    case 'pnpm':
      return `  → add to pnpm.overrides:  "${name}": "${bestFix}"`;
    case 'npm':
      return `  → add to overrides in package.json:  "${name}": "${bestFix}"`;
    case 'yarn':
      return `  → add to resolutions in package.json:  "${name}": "${bestFix}"`;
    case 'bun':
      return `  → pin transitive: install ${name}@${bestFix} as a direct dependency`;
  }
}

function logFixCommands(hits: AdvisoryHit[], pm: PackageManager): void {
  const deduped = new Map<string, AdvisoryHit>();
  for (const hit of hits) {
    const existing = deduped.get(hit.name);
    if (!existing || (hit.ids.length > existing.ids.length)) deduped.set(hit.name, hit);
  }
  const lines: string[] = [];
  for (const [name, hit] of deduped) {
    const line = formatFixLine(name, hit, pm);
    if (line) lines.push(line);
  }
  if (lines.length) {
    log.info(`fix:\n${lines.join('\n')}`);
  }
}

function formatAgentScan(result: { scanned: number; lockfileMissing: boolean; blocked: boolean; malware: { name: string; version: string; ids: string[] }[]; knownBadHits: { name: string; version: string; reason: string }[]; hits: AdvisoryHit[]; triaged: AdvisoryHit[]; severityCounts: AdvisorySeverityCounts }, pm: PackageManager): string {
  const lines: string[] = [];
  lines.push(`scanned:${result.scanned} blocked:${result.blocked}`);
  const sc = result.severityCounts;
  lines.push(`severity:critical=${sc.critical} high=${sc.high} moderate=${sc.moderate} low=${sc.low}`);
  if (result.triaged.length) lines.push(`triaged:${result.triaged.length}`);

  const grouped = new Map<string, AdvisoryHit[]>();
  for (const hit of result.hits) {
    const list = grouped.get(hit.name) ?? [];
    list.push(hit);
    grouped.set(hit.name, list);
  }
  for (const [name, group] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const hit of group.sort((a, b) => a.version.localeCompare(b.version))) {
      const sev = highestSeverity(hit.advisories ?? []) ?? 'low';
      const deps = hit.direct ? 'direct' : hit.direct === false ? 'transitive' : '';
      const ids = hit.ids.join(',');
      const fixVersions = [...new Set(hit.advisories?.flatMap((d) => d.fixedVersions ?? []))].join(',');
      lines.push(`pkg:${hit.name}@${hit.version} ${deps} severity:${sev} malware:${hit.malware} advisories:${ids}${fixVersions ? ` fixed:${fixVersions}` : ''}`);
    }
    // Fix command
    const anyHit = group[0];
    if (anyHit) {
      const fixStr: string[] = [];
      if (anyHit.malware) {
        fixStr.push(`remove ${name}`);
      } else {
        const allFixed = [...new Set(group.flatMap((h) => h.advisories?.flatMap((d) => d.fixedVersions ?? [])))].join(',');
        if (allFixed) {
          if (anyHit.direct) {
            fixStr.push(`update ${name} (screen ${pm} update ${name})`);
          } else {
            fixStr.push(`override ${name}=${allFixed} (${pm === 'pnpm' ? 'pnpm.overrides' : pm === 'yarn' ? 'resolutions' : 'overrides'})`);
          }
        }
      }
      if (fixStr.length) lines.push(`fix:${name} ${fixStr.join(' ')}`);
    }
  }
  return lines.join('\n');
}

async function runScanCommand(globals: Globals, pm: PackageManager, cwd: string): Promise<number> {
  const isAgent = globals.format === 'agent';
  const tty = process.stderr.isTTY && !globals.json && !isAgent;
  const s = tty ? spinner({ output: process.stderr }) : undefined;
  if (s) s.start('scan: checking installed packages for advisories …');
  const result = await runScan({
    pm,
    cwd,
    knownBad: loadKnownBad(cwd),
    onProgress: s ? (done, total) => s.message(`scan: checking ${done}/${total} packages …`) : undefined,
  });
  if (s) s.stop('');

  const blocked = result.malware.length > 0 || result.knownBadHits.length > 0;

  if (isAgent) {
    console.log(formatAgentScan({ scanned: result.scanned, lockfileMissing: result.lockfileMissing, blocked, malware: result.malware, knownBadHits: result.knownBadHits, hits: result.hits, triaged: result.triaged, severityCounts: result.severityCounts }, pm));
    return blocked ? 1 : 0;
  }

  if (globals.json) {
    console.log(
      JSON.stringify(
        {
          scanned: result.scanned,
          lockfileMissing: result.lockfileMissing,
          blocked,
          severityCounts: result.severityCounts,
          malware: result.malware,
          knownBadHits: result.knownBadHits,
          advisories: result.hits.filter((h) => !h.malware),
          triaged: result.triaged,
        },
        null,
        2,
      ),
    );
    return blocked ? 1 : 0;
  }
  if (result.lockfileMissing) {
    log.warn(`scan: no parseable lockfile for ${pm}, nothing to scan (commit a lockfile; bun has no parser yet)`);
    return 0;
  }

  // Summary header
  const uniqueAffected = new Set(result.hits.map((h) => h.name)).size;
  logScanSummary(result.severityCounts, uniqueAffected, result.scanned, result.triaged.length);

  // Triaged advisories
  if (result.triaged.length) {
    const triagedNames = [...new Set(result.triaged.map((h) => h.name))].sort();
    log.info(`scan: ${result.triaged.length} advisory hit(s) triaged via .screen-audit-ignore (${triagedNames.join(', ')})`);
  }

  // Advisory details
  logAdvisoryHits(result.hits);
  if (result.knownBadHits.length) logKnownBadHits(result.knownBadHits);

  // Fix commands
  if (result.hits.length) logFixCommands(result.hits, pm);

  if (blocked) {
    if (result.malware.length) log.error(`scan: ${result.malware.length} installed package(s) are NOW flagged as malware in OSV, remove or upgrade them (scanned ${result.scanned})`);
    if (result.knownBadHits.length) log.error(`scan: ${result.knownBadHits.length} installed package(s) match your blocklist/feeds (scanned ${result.scanned})`);
    return 1;
  }
  log.info(`scan: clean, no installed package is currently flagged as malware or blocklisted (scanned ${result.scanned})`);
  return 0;
}

/** Report blocklist / malware-feed matches. These are an explicit team decision, so they always block. */
function logKnownBadHits(hits: KnownBadHit[]): void {
  if (!hits.length) return;
  const lines = [
    `blocked by your blocklist, ${hits.length} package(s) are listed as known-bad:`,
    ...hits.map((h) => `  ${h.name}@${h.version} [${h.severity}], ${h.reason} (source: ${h.source})`),
    'options:',
    '  • remove or pin a different version of the package(s) above',
    `  • if this is a false positive, edit the matching entry in ${PROJECT_ADVISORY_NAME} (or your malware feed)`,
  ];
  log.error(lines.join('\n'));
}


/**
 * `forceCheck` is set by the explicit `check`/`preflight` commands: they ALWAYS query the OSV
 * advisory DB (and show risk hints), so a bare `sandbox check express` actually checks rather than
 * printing "no gates enabled". The install hot path leaves it false, so a normal install only pays
 * the OSV round-trip when the user opted in with `--fail-on-advisory`.
 */
function resolvePolicy(globals: Globals, config: SandboxConfig, route: Route, forceCheck = false): ActivePolicy {
  const riskLevel = globals.risk ?? config.install.riskHints;
  const riskHints = riskLevel !== 'off'; // `--risk off` always wins, even under a forced check
  const thorough = riskLevel === 'thorough';
  const minReleaseAgeDays = globals.minReleaseAge ?? config.install.minReleaseAgeDays;
  const failOnAdvisory = globals.failOnAdvisory ?? config.install.failOnAdvisory;
  const failOnDeprecated = globals.failOnDeprecated ?? config.install.failOnDeprecated;
  const failOnRisk = globals.failOnRisk ?? config.install.failOnRisk;
  const deep = globals.deep && (route.model === 'install' || route.model === 'add' || route.model === 'update' || route.model === 'auditFix');
  return {
    riskHints,
    minReleaseAgeDays,
    failOnAdvisory,
    failOnDeprecated,
    failOnRisk,
    deep,
    policy: {
      riskHints,
      thorough,
      minReleaseAgeDays,
      releaseAgeExclude: [...config.install.minReleaseAgeExclude, ...globals.allowRecent],
      deep,
      advisories: failOnAdvisory || forceCheck,
    },
  };
}

function logDeprecatedGate(hints: RiskHint[], failOnDeprecated: boolean): number | undefined {
  if (!hints.length) return undefined;
  const list = hints.map((h) => `  ${h.package}${h.version ? `@${h.version}` : ''}, ${h.message}`);
  if (!failOnDeprecated) {
    log.warn(['deprecated version(s) allowed via --allow-deprecated:', ...list].join('\n'));
    return undefined;
  }
  log.error(
    [
      'blocked: a maintainer-deprecated version would be installed; deprecated versions are abandoned and a supply-chain risk',
      ...list,
      'options:',
      '  • upgrade to a non-deprecated version',
      '  • override this once: add --allow-deprecated before the command',
    ].join('\n'),
  );
  return 1;
}

function logDeep(ap: ActivePolicy, result: PreflightResult, pm: PackageManager): void {
  if (!ap.deep) return;
  if (result.deepCount === 0) log.warn(`--deep: no lockfile tree for ${pm}; gated the direct deps instead`);
  else if (result.deepCount) log.info(`--deep: scanned ${result.deepCount} resolved packages from the lockfile (release age, deprecations, malware as enabled)`);
}

/**
 * The supply-chain preflight on the *install* path. Resolves the registry ONCE (in
 * {@link runPreflight}), runs every active gate over that one result, logs findings, and returns the
 * blocking exit code. Logging short-circuits at the first block (release-age → malware →
 * `--fail-on-risk`). Everything fails open on a lookup error. `--json`/`--dry-run` skip it entirely.
 */
/**
 * Compute and apply the safe-install freshness substitution for an `add` route. Deliberately isolated
 * from the gate path and from the risk-hint DISPLAY toggle, so it behaves the same on the real install,
 * under `--risk off` (which silences the advisory report but must not silently disable the freshness
 * hold-back), and in `--json`/`--dry-run` previews (where the previewed plan has to be the one that
 * actually runs). When the gate already resolved the registry WITH risk display on, those hints are
 * reused (`preHints`); otherwise a dedicated freshness-only resolve runs here. Fails open: a registry
 * error yields no substitution. `--fail-on-risk` opts out entirely (the operator gates risk manually).
 */
async function safeInstallRewrite(globals: Globals, config: SandboxConfig, facts: ProjectFacts, ap: ActivePolicy, route: Route, preHints?: RiskHint[]): Promise<{ route: Route; subs: Substitution[] }> {
  if (route.model !== 'add' || !config.install.safeInstall || ap.failOnRisk) return { route, subs: [] };
  const targets = riskTargetsForRoute(route, facts);
  // Use the route's pm, not the lockfile-probed facts.pm: `sandbox npm add x` in a pnpm repo must
  // rewrite with npm's flag/alias semantics (the manager the command actually runs), exactly as
  // planForRoute threads route.pm. riskHints:true here is the COMPUTE switch (resolve packuments +
  // derive recent_version); we consume only the freshness signal, so `--risk off` still silences the
  // advisory report elsewhere.
  const hints = preHints ?? (await runPreflight(targets, { riskHints: true, thorough: false, minReleaseAgeDays: 0, releaseAgeExclude: [], deep: false, advisories: false }, { pm: route.pm, cwd: facts.cwd })).hints;
  // Honor BOTH freshness trust lists, same as the release-age gate: the committed
  // install.minReleaseAgeExclude (e.g. "our own @scope/* is allowed fresh") and the ad-hoc
  // --allow-recent. ap.policy.releaseAgeExclude is exactly that combined set.
  const subs = freshSubstitutions(hints, targets.map((t) => t.name), { allowRecent: ap.policy.releaseAgeExclude });
  if (!subs.length) return { route, subs: [] };
  return { route: { ...route, pkgs: rewriteAddArgs(route.pkgs, subs, route.pm, config.install.pinExact) }, subs };
}

async function preflightRoute(globals: Globals, config: SandboxConfig, facts: ProjectFacts, route: Route): Promise<{ block: number } | { route: Route }> {
  const ap = resolvePolicy(globals, config, route);
  // Gate and report under the pm the command will actually run, not the repo-probed one (cross-PM
  // passthrough). gateFacts re-points the target derivation (incl. the --deep lockfile read) at it.
  const pm = effectivePm(route, facts.pm);
  const gateFacts: ProjectFacts = { ...facts, pm };

  // --json / --dry-run previews don't gate or block, but they MUST reflect safe-install, or the plan
  // they show is not the plan that runs (agents and CI read these to know exactly what will happen).
  if (globals.json || globals.dryRun) {
    return { route: (await safeInstallRewrite(globals, config, facts, ap, route)).route };
  }

  const knownBad = loadKnownBad(facts.cwd);
  const nothing = nothingToCheck(ap) && !knownBad.length;
  const wantSafe = route.model === 'add' && config.install.safeInstall && !ap.failOnRisk;
  if (nothing && !wantSafe) return { route };

  const targets = riskTargetsForRoute(route, gateFacts);
  // Run the gate preflight only when there's something to gate. With nothing to gate but safe-install to
  // do (e.g. `--risk off` with the default safeInstall on), skip straight to the substitution below.
  let result: PreflightResult | undefined;
  if (!nothing) {
    result = await runPreflight(targets, ap.policy, { pm, cwd: facts.cwd, knownBad });
    logDeep(ap, result, pm);
    // Blocklist / malware-feed match — an explicit team decision, so it blocks ahead of everything.
    if (result.knownBadHits.length) {
      logKnownBadHits(result.knownBadHits);
      return { block: 1 };
    }
    // Release-age gate — the strongest control, so it blocks first.
    if (result.ageViolations.length) {
      const suggestions = await suggestPins(result.ageViolations, ap.minReleaseAgeDays);
      logReleaseAgeBlock(result.ageViolations, ap.minReleaseAgeDays, pm, suggestions, gatingExistingDeps(route));
      return { block: 1 };
    }
    // Known-malware advisory.
    if (result.advisoryHits.length) {
      logAdvisoryHits(result.advisoryHits);
      if (result.advisoryHits.some((h) => h.malware)) {
        log.error('blocking: a version is flagged as malware and --fail-on-advisory is set');
        return { block: 1 };
      }
    }
    // Deprecated version — its own gate, blocked by default.
    const depExit = logDeprecatedGate(deprecatedHints(result), ap.failOnDeprecated);
    if (depExit !== undefined) return { block: depExit };
  }

  // Safe install: isolated from the risk-hint DISPLAY toggle. Reuse the gate's hints only when it ran
  // with risk display on (so they already carry the freshness signal); otherwise resolve freshness here.
  const { route: rewritten, subs } = await safeInstallRewrite(globals, config, facts, ap, route, result && ap.riskHints ? result.hints : undefined);
  const subNames = new Set(subs.map((s) => s.name));

  // Advisory/risk hints — advisory by default, blocking only with --fail-on-risk. The freshness hints
  // we're about to act on are dropped from the report (the receipt below is the authoritative line);
  // when --fail-on-risk is set nothing is substituted, so nothing is filtered and the block shows it all.
  if (ap.riskHints && result) {
    const reportHints = result.hints.filter((h) => !(h.code === 'recent_version' && subNames.has(h.package)));
    logRiskHints(targets, reportHints, { contained: true, pm });
    if (result.hints.length && ap.failOnRisk) {
      log.error('blocking because --fail-on-risk is set');
      return { block: 1 };
    }
  }
  if (subs.length && route.model === 'add') {
    // A substitution forces the command-wide exact flag, so co-installed packages land exact too unless
    // the user already opted into pinExact. Name them in the receipt so it isn't a silent surprise.
    log.info(formatSafeReceipt(subs, config.install.pinExact ? [] : incidentallyPinned(route.pkgs, subs)));
  }
  return { route: rewritten };
}

function renderPreflightJson(result: PreflightResult, suggestions: PinSuggestion[], blocked: boolean, pm: PackageManager): string {
  const days = (ms: number): number => Math.floor(ms / (24 * 60 * 60 * 1000));
  return JSON.stringify(
    {
      blocked,
      checked: result.checkedCount,
      deepChecked: result.deepCount ?? 0,
      hints: result.hints.filter((h) => h.code !== 'deprecated'), // deprecated reported in its own field
      ageViolations: result.ageViolations.map((v) => ({ name: v.name, version: v.version, publishedAt: v.publishedAt.toISOString(), ageDays: days(v.ageMs) })),
      advisoryHits: result.advisoryHits,
      knownBadHits: result.knownBadHits,
      deprecations: deprecatedHints(result).map((h) => ({ name: h.package, version: h.version, reason: h.code === 'deprecated' ? h.detail.deprecated : h.message })),
      suggestions: suggestions.map((s) => ({ name: s.name, version: s.version, pin: `screen ${pm} add ${s.name}@${s.version}`, ageDays: days(s.ageMs) })),
    },
    null,
    2,
  );
}

/**
 * The read-only `preflight` command: run the same gates as the install path but NEVER install —
 * report every finding (no short-circuit) and exit non-zero exactly when the matching install would
 * have been blocked. This is the review pass an agent/skill runs before deciding what flags to use,
 * and the human equivalent of "show me the risk before I commit". `--json` emits the findings plus
 * a concrete pin suggestion per blocked package; otherwise the same human lines as the install path.
 */
async function runPreflightCommand(globals: Globals, config: SandboxConfig, facts: ProjectFacts, route: Route, opts: { force?: boolean } = {}): Promise<number> {
  const ap = resolvePolicy(globals, config, route, opts.force);
  // Mirror the command's real pm (cross-PM passthrough), so the report and pin lines match what runs.
  const pm = effectivePm(route, facts.pm);
  const targets = riskTargetsForRoute(route, { ...facts, pm });
  const knownBad = loadKnownBad(facts.cwd);

  if (nothingToCheck(ap) && !knownBad.length) {
    if (globals.json) console.log(JSON.stringify({ blocked: false, gatesEnabled: false, checked: 0, hints: [], ageViolations: [], advisoryHits: [], knownBadHits: [], suggestions: [] }, null, 2));
    else log.info('no supply-chain gates enabled, pass --min-release-age, --fail-on-advisory, and/or --fail-on-risk (or `screen init --preset strict`)');
    return 0;
  }

  const result = await runPreflight(targets, ap.policy, { pm, cwd: facts.cwd, knownBad });
  const suggestions = result.ageViolations.length ? await suggestPins(result.ageViolations, ap.minReleaseAgeDays) : [];
  const exit = blockExit(result, ap) ?? 0;

  if (globals.json) {
    console.log(renderPreflightJson(result, suggestions, exit !== 0, pm));
    return exit;
  }

  // Human report: log every finding (no short-circuit — this is a report, not a gate).
  logDeep(ap, result, pm);
  if (result.knownBadHits.length) logKnownBadHits(result.knownBadHits);
  if (result.ageViolations.length) logReleaseAgeBlock(result.ageViolations, ap.minReleaseAgeDays, pm, suggestions, gatingExistingDeps(route));
  if (result.advisoryHits.length) logAdvisoryHits(result.advisoryHits);
  logDeprecatedGate(deprecatedHints(result), ap.failOnDeprecated);
  if (ap.riskHints) logRiskHints(targets, result.hints, { contained: false, pm });

  if (exit) log.error('preflight: would BLOCK this install, resolve the findings above, or re-run with an override flag');
  else log.info('preflight: no blocking findings, safe to install');
  return exit;
}

/**
 * `sandbox secrets [path]` — offline scan for committed credentials. The sandbox keeps host secrets
 * OUT of the install container, but can't stop a key being committed into the repo; this is the
 * visibility half of the credential mission. Read-only, no container. Exits non-zero on any finding
 * (a CI tripwire). Matched values are redacted — it reports where, never the secret itself.
 */
function runSecretsCommand(globals: Globals, root: string): number {
  let findings: SecretFinding[];
  try {
    findings = scanSecrets(root);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (globals.json) {
    console.log(JSON.stringify({ root, found: findings.length, findings }, null, 2));
    return findings.length ? 1 : 0;
  }
  if (!findings.length) {
    log.info('secrets: clean, no credential patterns found in the scanned files');
    return 0;
  }
  for (const f of findings) log.error(`${f.file}:${f.line}, ${f.label} (${f.ruleId}): ${f.redacted}`);
  log.error(`secrets: ${findings.length} potential credential(s) found, rotate any real key, move it to an env var, and add the file to .gitignore`);
  return 1;
}

/**
 * `sandbox feeds update` — fetch the malware FEEDS in install.malwareFeeds and cache them locally so
 * the install-time blocklist check stays offline. Augments OSV (which has publish lag) with feeds the
 * team trusts. `sandbox feeds list` shows the configured feeds and what's cached.
 */
async function runFeedsCommand(globals: Globals, config: SandboxConfig, args: string[]): Promise<number> {
  const sub = args[0] ?? 'update';
  const feeds = config.install.malwareFeeds;
  if (sub === 'list') {
    if (globals.json) console.log(JSON.stringify({ feeds, cacheDir: feedCacheDir() }, null, 2));
    else {
      log.info(feeds.length ? `configured malware feeds (install.malwareFeeds):\n${feeds.map((f) => `  • ${f}`).join('\n')}` : 'no malware feeds configured, add URLs to install.malwareFeeds in screen.config.json');
      log.info(`feed cache: ${feedCacheDir()}`);
    }
    return 0;
  }
  if (sub !== 'update') fail('usage: screen feeds <update|list>');
  if (!feeds.length) {
    log.info('feeds: nothing to update, add malware feed URLs to install.malwareFeeds in screen.config.json first');
    return 0;
  }
  log.info(`feeds: fetching ${feeds.length} feed(s) …`);
  const results = await updateFeeds(feeds);
  if (globals.json) {
    console.log(JSON.stringify({ results, cacheDir: feedCacheDir() }, null, 2));
  } else {
    for (const r of results) {
      if (r.error) log.error(`  ✗ ${r.feed}, ${r.error}`);
      else log.info(`  ✓ ${r.feed}, ${r.count} package(s) cached`);
    }
  }
  return results.some((r) => r.error) ? 1 : 0;
}

/** Read the base (merge-target) lockfile for `delta`: an explicit file, else `git show <ref>:<lockfile>`. */
function readBaseLockfile(rootDir: string, pm: PackageManager, baseRef: string, baseFile?: string): LockfilePackage[] | undefined {
  try {
    const text = baseFile
      ? readFileSync(baseFile, 'utf8')
      : execFileSync('git', ['show', `${baseRef}:${lockfileName(pm)}`], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseLockfilePackages(text, pm);
  } catch {
    return undefined; // missing ref/file/git → caller treats every head package as changed (gate-all)
  }
}

/**
 * `sandbox delta` — gate only the dependency changes a PR introduces. Diffs the head lockfile against
 * `--base` (default origin/main) or `--base-lockfile`, then runs the same blocking gates as the
 * install path over just the added/bumped versions. Low-noise PR check: judges what it introduces.
 */
async function runDeltaCommand(globals: Globals, config: SandboxConfig, facts: ProjectFacts, rootDir: string, args: string[]): Promise<number> {
  let baseRef = 'origin/main';
  let baseFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base') baseRef = args[++i] ?? baseRef;
    else if (args[i] === '--base-lockfile') baseFile = args[++i];
  }

  const minReleaseAgeDays = globals.minReleaseAge ?? config.install.minReleaseAgeDays;
  const advisories = globals.failOnAdvisory ?? config.install.failOnAdvisory;
  const failOnDeprecated = globals.failOnDeprecated ?? config.install.failOnDeprecated;
  if (minReleaseAgeDays === 0 && !advisories) {
    log.info('delta: no blocking gates enabled, pass --min-release-age and/or --fail-on-advisory (or `screen init --preset strict`)');
  }

  const base = readBaseLockfile(rootDir, facts.pm, baseRef, baseFile);
  const baseMissing = base === undefined;
  const result = await runDelta(
    { minReleaseAgeDays, releaseAgeExclude: [...config.install.minReleaseAgeExclude, ...globals.allowRecent], advisories },
    { pm: facts.pm, cwd: facts.cwd, base: base ?? [], baseMissing, knownBad: loadKnownBad(facts.cwd) },
  );

  const suggestions = result.ageViolations.length ? await suggestPins(result.ageViolations, minReleaseAgeDays) : [];
  const blocked = result.knownBadHits.length > 0 || result.ageViolations.length > 0 || result.advisoryHits.some((h) => h.malware) || (failOnDeprecated && result.deprecated.length > 0);

  if (globals.json) {
    const days = (ms: number): number => Math.floor(ms / (24 * 60 * 60 * 1000));
    console.log(
      JSON.stringify(
        {
          base: baseFile ?? baseRef,
          baseMissing,
          changed: result.changed.length,
          blocked,
          ageViolations: result.ageViolations.map((v) => ({ name: v.name, version: v.version, publishedAt: v.publishedAt.toISOString(), ageDays: days(v.ageMs) })),
          advisoryHits: result.advisoryHits,
          knownBadHits: result.knownBadHits,
          deprecations: result.deprecated.map((h) => ({ name: h.package, version: h.version, message: h.message })),
          suggestions: suggestions.map((s) => ({ name: s.name, version: s.version, pin: `screen ${facts.pm} add ${s.name}@${s.version}`, ageDays: days(s.ageMs) })),
        },
        null,
        2,
      ),
    );
    return blocked ? 1 : 0;
  }

  if (baseMissing) log.warn(`delta: couldn't read the base lockfile (${baseFile ?? baseRef}), gating ALL ${result.changed.length} resolved packages as a precaution`);
  if (result.changed.length === 0) {
    log.info(`delta: no dependency changes vs ${baseFile ?? baseRef}, nothing to gate`);
    return 0;
  }
  log.info(`delta: ${result.changed.length} added/changed package(s) vs ${baseFile ?? baseRef}`);
  if (result.knownBadHits.length) logKnownBadHits(result.knownBadHits);
  if (result.ageViolations.length) logReleaseAgeBlock(result.ageViolations, minReleaseAgeDays, facts.pm, suggestions);
  if (result.advisoryHits.length) logAdvisoryHits(result.advisoryHits);
  logDeprecatedGate(result.deprecated, failOnDeprecated);
  if (blocked) log.error('delta: would BLOCK this PR, a changed dependency above hit a gate');
  else log.info('delta: no blocking findings in the changed dependencies');
  return blocked ? 1 : 0;
}

const UPGRADE_TARGETS = ['latest', 'minor', 'patch', 'newest', 'greatest', 'semver'] as const;

interface UpgradeArgs {
  write: boolean;
  yes: boolean;
  target: UpgradeTarget;
  reject: string[];
}

function parseUpgradeArgs(args: string[]): UpgradeArgs {
  const out: UpgradeArgs = { write: false, yes: false, target: 'latest', reject: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--write' || a === '-w') out.write = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--minor') out.target = 'minor';
    else if (a === '--patch') out.target = 'patch';
    else if (a === '--target') {
      const t = args[++i];
      if (!t || !(UPGRADE_TARGETS as readonly string[]).includes(t)) fail(`--target needs one of: ${UPGRADE_TARGETS.join('|')} (got '${t ?? ''}')`);
      out.target = t as UpgradeTarget;
    } else if (a === '--reject') out.reject.push(args[++i] ?? '');
    else fail(`unknown upgrade flag '${a}', try: --write · --minor · --patch · --target <${UPGRADE_TARGETS.join('|')}> · --reject <pat> · --yes`);
  }
  out.reject = out.reject.filter(Boolean);
  return out;
}

/**
 * `sandbox upgrade` — move declared dependency RANGES to newer versions (what npm-check-updates does),
 * which `sandbox npm update` won't: update stays within the existing range. The release-age threshold
 * from screen.config.json drives ncu's `--cooldown`, so the user never re-types it and the two can't
 * drift. ncu (host-only: it just reads/writes package.json + queries the registry) proposes; the SAME
 * gate engine the install path uses vets the proposed versions; only on `--write` does it rewrite
 * package.json and then apply the change through the JAILED install. Blocked upgrades never write.
 */
async function runUpgradeCommand(
  globals: Globals,
  config: SandboxConfig,
  facts: ProjectFacts,
  args: string[],
  runInstall: () => Promise<number>,
  ncu: NcuRunner = defaultNcuRunner(),
): Promise<number> {
  const ua = parseUpgradeArgs(args);
  // One source of truth: the install gate's resolved policy. cooldown == the release-age threshold;
  // the cooldown-exempt set == the same packages the age gate exempts (config + --allow-recent).
  const ap = resolvePolicy(globals, config, { model: 'install', pm: facts.pm, frozen: false, args: [] });
  const cooldownDays = ap.minReleaseAgeDays;
  const exempt = ap.policy.releaseAgeExclude;
  const policy: UpgradePolicy = { cooldownDays, target: ua.target, reject: ua.reject, filter: [] };

  if (!globals.json) {
    const src = globals.minReleaseAge !== undefined ? '--min-release-age' : 'screen.config.json';
    const ex = exempt.length ? `, ${exempt.length} exempt` : '';
    const cd = cooldownDays > 0 ? ` · cooldown ${cooldownDays}d (from ${src}${ex})` : ' · no cooldown (release-age gate off)';
    log.info(`upgrade: checking ${facts.pm} for newer ${ua.target} versions${cd} …`);
  }

  // Discovery: one pass normally, two when a cooldown exemption must be honored (ncu's cooldown is
  // global). Proceed if ANY pass produced output; only error when every pass failed to run.
  const current = readDeclaredRanges(facts.cwd);
  const passes = ncuPasses(policy, exempt, facts.pm);
  const lists: ProposedUpgrade[][] = [];
  let ran = false;
  for (const argv of passes) {
    const r = ncu(argv, facts.cwd);
    if (r.code === 0 || r.stdout.trim()) {
      ran = true;
      lists.push(parseUpgrades(r.stdout, current));
    }
  }
  if (!ran) {
    log.error(`upgrade: ${NCU_SPEC} couldn't run, check the network and the npm-check-updates output above`);
    return 1;
  }
  const upgrades = mergeProposals(lists);

  if (upgrades.length === 0) {
    if (globals.json) console.log(JSON.stringify({ cooldownDays, target: ua.target, blocked: false, upgrades: [] }, null, 2));
    else log.info(`upgrade: every dependency is already at its newest eligible ${ua.target} version${cooldownDays ? ` within the ${cooldownDays}-day cooldown` : ''}, nothing to do`);
    return 0;
  }

  // Vet the proposed target versions through the install-path gates so `upgrade` carries identical
  // guarantees. Cooldown already filtered fresh publishes inside ncu; re-running the age gate here is
  // belt-and-suspenders and catches any reject/exclude drift. Direct targets only (no --deep tree).
  const gatePolicy: PreflightPolicy = { ...ap.policy, deep: false };
  const result = await runPreflight(upgradeTargets(upgrades), gatePolicy, { pm: facts.pm, cwd: facts.cwd, knownBad: loadKnownBad(facts.cwd) });
  const deps = deprecatedHints(result);
  const rows = classifyUpgrades(upgrades, {
    ageNames: new Set(result.ageViolations.map((v) => v.name)),
    malwareNames: new Set(result.advisoryHits.filter((h) => h.malware).map((h) => h.name)),
    deprecatedNames: new Set(deps.map((h) => h.package)),
  });
  const blocked = blockExit(result, ap) !== undefined;
  const suggestions = result.ageViolations.length ? await suggestPins(result.ageViolations, cooldownDays) : [];

  if (globals.json) {
    console.log(JSON.stringify({ cooldownDays, target: ua.target, blocked, upgrades: rows.map((r) => ({ name: r.name, from: r.from, to: r.to, gate: r.gate })) }, null, 2));
    return blocked ? 1 : 0;
  }

  log.info(`upgrade: ${rows.length} package(s) can move:\n${renderUpgradeTable(rows)}`);

  if (blocked) {
    if (result.knownBadHits.length) logKnownBadHits(result.knownBadHits);
    if (result.ageViolations.length) logReleaseAgeBlock(result.ageViolations, cooldownDays, facts.pm, suggestions);
    if (result.advisoryHits.length) logAdvisoryHits(result.advisoryHits);
    logDeprecatedGate(deps, ap.failOnDeprecated);
    log.error('upgrade: BLOCKED, a proposed upgrade hit a gate. package.json is untouched. Skip it with --reject <pkg>, or pin a known-good version.');
    return 1;
  }

  if (!ua.write) {
    log.info('upgrade: all proposed upgrades pass the gates. Apply them with:  screen upgrade --write');
    return 0;
  }

  if (!ua.yes && process.stdout.isTTY) {
    const ok = await confirm({ message: `Write these ${rows.length} upgrade(s) to package.json and install to refresh the lockfile?` });
    if (isCancel(ok) || !ok) {
      log.info('upgrade: cancelled, package.json untouched');
      return 0;
    }
  }

  // Write exactly what was gated — apply the previewed `to` ranges directly, so no version published
  // between preview and write can slip in. (ncu is discovery-only; it never writes.)
  const pkgPath = path.join(facts.cwd, 'package.json');
  try {
    writeFileSync(pkgPath, applyUpgrades(readFileSync(pkgPath, 'utf8'), rows));
  } catch (e) {
    log.error(`upgrade: couldn't write package.json (${e instanceof Error ? e.message : String(e)}); nothing changed`);
    return 1;
  }
  log.info(`upgrade: package.json updated (${rows.length} dep(s)); installing to refresh the lockfile …`);
  return runInstall();
}

/**
 * Print the "new version available" notice (from cache — never blocks) and kick off the once-a-day
 * background refresh. Stays out of the way: only on an interactive stderr, and skipped for machine
 * output (--json/--dry-run), CI, and the documented opt-outs (--no-update-check, NO_UPDATE_NOTIFIER,
 * config `updateCheck: false`). `cliEntry` is this bin's path, used to re-spawn the detached checker.
 */
function maybeNotifyUpdate(globals: Globals, cliEntry: string, rootDir: string, configPath?: string): void {
  if (globals.json || globals.dryRun || globals.noUpdateCheck || disabledByEnv() || !process.stderr.isTTY) return;
  try {
    if (!readConfig(rootDir, configPath).updateCheck) return;
  } catch {
    // unreadable/invalid config — fall through; the check is harmless and env/flag opt-outs still apply
  }
  const current = selfVersion();
  if (!current) return;
  const banner = updateBanner(current);
  if (banner) process.stderr.write(banner);
  scheduleUpdateCheck(cliEntry);
}

async function main(): Promise<number> {
  const rawArgv = process.argv.slice(2);
  const selfArgv = unwrapSelfInvocation(rawArgv);
  // Multi-call binary: `sandbox-pnpm add zod` (or `spnpm add zod`) is THIS bundle fronting a package
  // manager. The bin/ launcher sets SCREEN_PM_BIN to the leader (a PM shim can re-exec us and lose
  // argv[0], so the bin name alone isn't reliable); `leaderForBin` is the fallback for running the
  // bundle directly under a `sandbox-<pm>`-named symlink. The leader (pnpm) is implicit, so parse the
  // args normally and fold the parsed command back in as the PM's first argument, which keeps global
  // flags working. A `sandbox-<pm>` run always containerizes, exactly like `sandbox <pm>`.
  const binLeader = process.env.SCREEN_PM_BIN ?? leaderForBin(path.basename(process.argv[1] ?? ''));
  const parsed = parse(selfArgv ?? rawArgv);
  const globals = parsed.globals;
  const { cmd, args } = foldBinLeader(binLeader, parsed);
  if (selfArgv) {
    const shown = ['screen', ...selfArgv].join(' ').trim();
    // Action + why, in one line: what we're doing, and the plain reason it's safe/expected.
    log.info(`using the screen already on your machine, \`${shown}\` runs directly, instead of fetching the CLI again through npx`);
  }

  // Hidden re-entry: the detached background checker (spawned by scheduleUpdateCheck) runs one
  // registry lookup, writes the cache, and exits. Must short-circuit before any other dispatch.
  if (cmd === '__update-check') {
    await refreshUpdateCache();
    return 0;
  }

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-v' || cmd === '-V') {
    process.stdout.write(`${selfVersion() ?? 'unknown'}\n`);
    return 0;
  }

  if (cmd === 'completion') {
    const shell = args.find((a) => !a.startsWith('-'));
    if (!shell) fail(`usage: screen completion <${COMPLETION_SHELLS.join('|')}>`);
    if (!isCompletionShell(shell)) fail(`unknown shell '${shell}' (use: ${COMPLETION_SHELLS.join(' | ')})`);
    process.stdout.write(completionScript(shell));
    return 0;
  }

  const invocationCwd = process.cwd();
  const context = resolveProjectContext(invocationCwd, globals.config);
  maybeNotifyUpdate(globals, process.argv[1] ?? '', context.rootDir, context.configPath);

  if (cmd === 'init') {
    let preset: string | undefined;
    let force = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--preset') preset = args[++i];
      else if (args[i] === '--vibe') preset = 'vibe'; // sugar for the common "explore + run dev" setup
      else if (args[i] === '--agent') preset = 'agent'; // sugar for the coding-agent setup
      else if (args[i] === '--force') force = true;
    }
    return runInit(context.rootDir, { preset, force });
  }

  if (cmd === 'setup') {
    let preset: string | undefined;
    let force = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--preset') preset = args[++i];
      else if (args[i] === '--vibe') preset = 'vibe';
      else if (args[i] === '--agent') preset = 'agent';
      else if (args[i] === '--force') force = true;
    }
    return runSetup(context.rootDir, { preset, force });
  }

  if (cmd === 'verify') {
    const wantSign = args.includes('--sign');
    // When signing, keep stdout clean for the receipt — route any --scan/--secrets findings to
    // stderr (human lines) rather than letting their --json output collide with the receipt.
    const gateGlobals = wantSign ? { ...globals, json: false } : globals;
    const checks = ['boundary'];
    let code = await runVerify(context.rootDir, context.configPath);
    // --scan: also run the retroactive malware sweep, so a green verify means
    // "boundary intact AND no installed dep is currently flagged as malware".
    if (args.includes('--scan')) {
      code = code || (await runScanCommand(gateGlobals, resolvePackageManager(context.rootDir), context.rootDir));
      checks.push('scan');
    }
    // --secrets: also fail if a credential is committed in the repo.
    if (args.includes('--secrets')) {
      code = code || runSecretsCommand(gateGlobals, context.rootDir);
      checks.push('secrets');
    }
    if (!wantSign) return code;
    // --sign: emit an Ed25519-signed receipt — but ONLY when every requested gate passed, so the
    // receipt can never attest a "green" boundary while --scan found malware or --secrets found a key.
    if (code !== 0) {
      log.error('verify --sign: not signing, a check above failed; fix it before requesting a receipt');
      return code;
    }
    const keyFile = process.env.SCREEN_SIGNING_KEY;
    if (!keyFile) fail('verify --sign needs a signing key: generate one with `screen keygen`, then set SCREEN_SIGNING_KEY to the private-key file');
    const receipt = signVerifyReceipt(context.rootDir, readSigningKey(keyFile), { configPath: context.configPath, now: new Date(), checks });
    if (!receipt) return runVerify(context.rootDir, context.configPath); // boundary regressed since the check above (shouldn't happen)
    console.log(JSON.stringify(receipt, null, 2));
    return 0;
  }

  if (cmd === 'verify-receipt') {
    const file = args.find((a) => !a.startsWith('-'));
    if (!file) fail('usage: screen verify-receipt <file.json> [--fingerprint <hex>]');
    const fpIdx = args.indexOf('--fingerprint');
    const trustedFingerprint = (fpIdx >= 0 ? args[fpIdx + 1] : undefined) ?? process.env.SCREEN_TRUSTED_KEY;
    return runVerifyReceipt(path.resolve(invocationCwd, file), { trustedFingerprint, json: globals.json });
  }

  if (cmd === 'keygen') {
    return runKeygen({ json: globals.json });
  }

  if (cmd === 'audit') {
    const sub = args[0];
    if (sub !== 'verify') fail('usage: screen audit verify <log.jsonl>  (the hash-chained audit log; set SCREEN_AUDIT_LOG to write one)');
    const file = args.slice(1).find((a) => !a.startsWith('-')) ?? process.env.SCREEN_AUDIT_LOG;
    if (!file) fail('usage: screen audit verify <log.jsonl>  (or set SCREEN_AUDIT_LOG)');
    return runAuditVerify(path.resolve(invocationCwd, file), { json: globals.json });
  }

  if (cmd === 'scan') {
    return runScanCommand(globals, resolvePackageManager(context.rootDir), context.rootDir);
  }

  if (cmd === 'secrets') {
    const target = args.find((a) => !a.startsWith('-'));
    return runSecretsCommand(globals, target ? path.resolve(invocationCwd, target) : context.rootDir);
  }

  if (cmd === 'feeds') {
    return runFeedsCommand(globals, readConfig(context.rootDir, context.configPath), args);
  }

  if (cmd === 'badge') {
    let workflow: string | undefined;
    let slug: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--workflow') workflow = args[++i];
      else if (args[i] === '--repo') slug = args[++i];
    }
    console.log(renderBadge(context.rootDir, { workflow, slug }));
    return 0;
  }

  if (cmd === 'doctor') {
    return runDoctor(context.rootDir, {
      config: context.configPath,
      invocationCwd,
      runWorkdir: context.runWorkdir,
    });
  }

  if (cmd === 'allow') {
    const hosts = args.filter(Boolean);
    if (!hosts.length) fail('usage: screen allow <host...>');
    const result = allowHosts(context.rootDir, hosts, context.configPath);
    console.log(`screen: updated ${context.configPath ?? 'screen.config.json'}`);
    console.log(result.added.length ? `screen: allowed ${result.added.join(', ')}` : 'screen: no new hosts added (already covered)');
    return 0;
  }

  if (cmd === 'off' || cmd === 'on') {
    // One-keystroke toggle of the `off` escape hatch, written to the personal local override so it
    // never touches the committed team config. `off` → installs run on the host here; `on` → back in
    // the sandbox (and overrides a committed off:true, since local layers win).
    const projectFile = context.configPath ?? path.join(context.rootDir, 'screen.config.json');
    const file = path.relative(context.rootDir, setLocalOff(projectFile, cmd === 'off')) || path.basename(projectFile);
    // Keep the personal override out of git — committing off:true would silently disable screening
    // for the whole team. Idempotent; only relevant when the project never ran init/setup.
    if (ensureLocalConfigIgnored(context.rootDir)) log.info(`added ${path.basename(file)} to .gitignore so it can't be committed`);
    if (cmd === 'off') {
      log.warn(`screening is now off for this project. Wrote off:true to ${file}. Future commands here run without screening, straight to your package manager. Re-enable: \`screen on\`.`);
      if (process.env.SCREEN_OFF) log.info('note: SCREEN_OFF is also set in this shell, so screening stays off here until you unset it too');
    } else {
      log.info(`screening is on again for this project. Wrote off:false to ${file}.${process.env.SCREEN_OFF ? ' SCREEN_OFF is still set in this shell, so unset it before retrying.' : ''}`);
    }
    return 0;
  }

  const loaded = loadConfig(context.rootDir, context.configPath);
  for (const warning of loaded.warnings) log.warn(warning);
  // `sandbox dev` is sugar for `sandbox --dev <dev|start|serve>`: fold it into globals here so the
  // dev-mode network/devPorts open up in the ONE effective config every path below shares.
  if (cmd === 'dev') globals.dev = true;
  const config = applyOneOffModes(loaded.config, globals);
  const facts = probeProject(context.rootDir, config, {
    envFiles: globals.envFiles.filter(Boolean),
    envFileBaseDir: context.cwd,
    configEnvFilesBaseDir: context.rootDir,
  });
  const opts: PlanOptions = { workdir: context.runWorkdir, envNames: globals.envNames.filter(Boolean) };
  if (globals.frozen) opts.frozen = true;

  // Everything the write/install orchestration (src/write.ts) needs, bundled once. The write path lives
  // outside this self-executing module so it can be unit-tested with a fake backend.
  const writeCtx: WriteContext = { config, facts, opts, globals, project: context, cmd, args, binLeader };

  if (cmd === 'approve-builds') {
    // Resolve pnpm's ignored dependency build scripts without hand-editing YAML. With no package
    // names, approves everything pnpm left pending; names can also pre-approve specific packages.
    // `--deny` records the opposite decision (don't build) so pnpm stops re-prompting.
    if (facts.pm !== 'pnpm') {
      log.warn(`approve-builds resolves pnpm's ignored build scripts; this project uses ${facts.pm}`);
      return 0;
    }
    const named = args.filter((a) => !a.startsWith('-'));
    const deny = args.includes('--deny') || args.includes('--none');
    const targets = named.length ? named : findPendingBuilds(context.rootDir);
    if (!targets.length) {
      log.info('no dependency build scripts are awaiting approval');
      return 0;
    }
    const r = writeBuildApprovals(context.rootDir, new Map(targets.map((n) => [n, !deny])));
    log.info(`${deny ? 'denied' : 'approved'} build scripts: ${(deny ? r.denied : r.allowed).join(', ')}`);
    if (deny) return 0;
    log.info('re-running install so the approved scripts build');
    // Re-install through the mode-aware path so a host-native project rebuilds natively (a contained
    // reinstall would clobber its tree with a Linux one), and a container project stays contained.
    return runWrite(writeCtx, { model: 'install', pm: facts.pm, frozen: false, args: [] });
  }

  if (cmd === 'delta') {
    return runDeltaCommand(globals, config, facts, context.rootDir, args);
  }

  if (cmd === 'upgrade') {
    // On --write, install the rewritten package.json through the same mode-aware write path as
    // `screen install` (native on a host-native or fresh project, contained when the tree already is).
    const runInstall = () => runWrite(writeCtx, { model: 'install', pm: facts.pm, frozen: false, args: [] });
    return runUpgradeCommand(globals, config, facts, args, runInstall);
  }

  if (cmd === 'check') {
    // Audit packages WITHOUT installing — a read-only review pass. No container, no Docker: it only
    // queries the registry and the OSV advisory DB. Takes bare package names the friendly way
    // (`sandbox check express lodash@4`), a full command (`check npm install x`), or no args (audit the
    // current manifest). `force` makes OSV always run, so a bare `check` checks instead of reporting
    // "no gates enabled".
    return runPreflightCommand(globals, config, facts, checkRouteFor(args, facts, context.cwd), { force: true });
  }

  if (cmd === 'preflight') {
    // `sandbox preflight [cmd…]` mirrors a SPECIFIC install command's gates (unknown words error like
    // any command, unlike `check`'s bare-name form). Default to the install surface; force OSV so the
    // review always queries the advisory DB.
    const inner = args[0];
    const checkRoute = inner ? resolveCommand(inner, args.slice(1), facts) : resolveCommand('install', [], facts);
    return runPreflightCommand(globals, config, facts, checkRoute, { force: true });
  }

  const route = resolveCommand(cmd, args, facts);
  // Screening off (config `off:true` or SCREEN_OFF) → run the operation straight on the host without
  // screening, as if the wrapper weren't in front of it. Checked before the gates: off means off.
  if (sandboxOff(config)) {
    return runOnHost(hostCommandFor(cmd, args, route, resolvedFrozen(route, opts, config), facts.isYarnBerry), facts.cwd, globals);
  }
  // A global install is host tooling. screen-node installs on the host anyway, so run it directly.
  // Global installs are not screened: the gates target a project's resolved dependency tree, not
  // globally-installed bins.
  if (isGlobalInstall(cmd, route, args)) {
    return execOnHost(hostCommandFor(cmd, args, route, resolvedFrozen(route, opts, config), facts.isYarnBerry), facts.cwd, globals, 'global install: host tooling, not screened');
  }
  const outcome = await preflightRoute(globals, config, facts, route);
  if ('block' in outcome) return outcome.block;

  // A tree-mutating install goes through the write path (screen, then install natively on the host),
  // shared with approve-builds and upgrade --write. Everything else (run, audit, read-only) has no tree
  // to place, so it runs natively as a pass-through. The write path and the build-approval loop live in
  // src/write.ts behind one entry; cli stays the wiring layer.
  return runWrite(writeCtx, outcome.route);
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
