---
name: sandbox-install
description: Human-in-the-loop secure install for npm/pnpm/yarn/bun deps, driven by the `sandbox` CLI (@jagreehal/sandbox-node). Runs a read-only `check` review pass (no Docker) that reports supply-chain risk WITHOUT installing, surfaces each finding with a recommended action (including a concrete older version to pin), lets the user choose, then runs the real install with the matching flags. Use when the user wants to install, add, remove, or update dependencies safely, vet a package before installing, review supply-chain risk (fresh releases, OSV advisories, known malware), or asks to "sandbox install" / "check this package".
---

# sandbox-install

The `sandbox` CLI ships a supply-chain review pass and a container boundary on demand. The
everyday write path vets first, then installs mode-aware (native on a host-native or fresh project,
contained when the tree already is); explicit `sandbox <pm>` or a devcontainer always containerize.
This skill is the **interactive front-end**: the CLI is pure
flags, and you (the agent) are the human-in-the-loop. You drive the flags; the user makes the
risk calls.

The `check` command runs the gates and reports findings **without installing anything** (and
needs no Docker, it only queries the registry + OSV). Run the review pass first, then run the
real install once the user has cleared the risk. `check` takes bare package names the friendly
way (`sandbox check express lodash@4`); `preflight` is the same review keyed to a full command
(`preflight npm install …`). Both accept the same gate flags below.

**The write path leads with `sandbox install`, `sandbox add <pkg>`, `sandbox update`.** These are
the commands to teach and use: each one vets with the gate engine, then installs mode-aware (native
on a host-native or fresh project, contained when the tree already is). sandbox auto-detects the
project's package manager, so you do not name it. Before each write the CLI prints one line saying
what's about to happen and why, such as
`installing natively on the host with pnpm (host-native deps; gates ran, no container boundary)` or
`installing in a throwaway container with pnpm (container-built deps; no host creds, default-deny egress)`.
A native install runs lifecycle scripts on the host, so the gates are heuristics, not a boundary; the
container is the boundary. The per-PM binaries (`spnpm`, `snpm`, …) are the same mode-aware path with
shorter keystrokes; they live in the Expert section below.

## Workflow

1. **Confirm the tool is present.** `sandbox doctor` (or `npx @jagreehal/sandbox-node doctor`).
   If there's no `sandbox.config.json`, run `sandbox init --preset balanced` first. The write
   commands to teach are `sandbox install`, `sandbox add <pkg>`, and `sandbox update`: sandbox
   detects the package manager from the project, vets the targets, then installs mode-aware (native
   on a host-native or fresh project, contained when the tree already is). Use explicit `sandbox <pm>`
   when the user wants the throwaway container boundary.

   For scripts, prefer the short form: `sandbox dev`, `sandbox test`, `sandbox lint`. If a script
   name collides with a sandbox command such as `build`, use `sandbox script build`.

   If `package.json` pins a `"packageManager"` (pnpm/yarn) other than the image's baked default,
   the first install bakes that version into the image, so expect a one-time image build before the
   install runs. This happens automatically; no config needed.

   For a project with native modules (node-gyp, Prisma, Playwright, Cypress, Electron) that download
   binaries during `postinstall`, the interactive `sandbox init` picker can pre-allow the
   `build-tools` egress bundle so those installs don't block on the first run (see step 4).

2. **Review pass: check WITHOUT installing.** Use `check`: it runs the gates over what would be
   pulled and **never installs** (no Docker needed), so run it first. It always queries OSV, so you
   don't need `--fail-on-advisory` just to *see* advisories: add the gate flags only to *block*.

   ```
   sandbox --json --fail-on-risk --fail-on-advisory --min-release-age 7 check [pkgs]
   ```

   - `sandbox check express lodash@4`: bare package names (the friendly form).
   - `sandbox check` (no args): audits the whole project: the root manifest **and every workspace
     package.json** in a monorepo, deduped.
   - `sandbox check ./packages/api/package.json`: the deps in a specific manifest (a `package.json`
     is read workspace-aware; relative paths resolve from your current directory).
   - `sandbox --fail-on-advisory check npm install zod`: the command-mirroring form (`preflight` is
     the same).

   **Reproducing an existing committed lockfile (CI, a fresh clone, a frozen install)?** A bare
   `check` / `preflight <pm> install` gates *every* dependency, so an actively-maintained project trips the
   release-age gate on packages that are already committed and vetted (noise, not new risk). For that
   case run `sandbox delta` instead: it diffs the lockfile against the merge base (default
   `origin/main`) and gates only the added/bumped versions, i.e. exactly what a change introduces.
   When a bare-install review blocks on release-age, its output now points here too. Reserve the
   full `check [pkgs]` for when you are genuinely adding packages.

   - Exit **0** → no blocking findings. Go to step 4 and run the real install.
   - Exit **1** → would block. Read the findings and go to step 3.
   - `--json` returns a structured report: `{ blocked, checked, hints, ageViolations,
     advisoryHits, suggestions }`. Each `suggestions[]` entry has a ready-to-run `pin`
     command (e.g. `sandbox npm add left-pad@1.2.0`). Drop `--json` for human-readable lines.

   **Removing a dependency** (`sandbox remove <pkg>`) needs no review pass: it fetches nothing
   new. It still runs contained, so the removed package's uninstall scripts can't touch the host.
   Just run it.

3. **Map each finding to a recommended action**, then present them to the user (use
   AskUserQuestion when there's a clear choice; recommend the safe default first):

   | Finding (from output) | Blocks the pass? | Recommend | If user agrees, install with |
   |---|---|---|---|
   | **KNOWN MALWARE** (`MAL-…` advisory) | yes | **Abort.** Do not offer an easy proceed. | stop; suggest reporting it |
   | **Deprecated version** (`deprecations[]`) | yes (default) | Upgrade to a non-deprecated version | `--allow-deprecated` **only if the user insists** (a deprecated version is abandoned and a supply-chain risk) |
   | Release-age violation (published N days ago) | yes | Pin the suggested older version | the `pin` command from `suggestions[]` · or exempt: `--allow-recent <pkg>` |
   | Risk hint `recent_version` (fresh version, worm window) | no | **Handled for you on `add` by default** (see safe-install note) | nothing; or `--allow-recent <pkg>` to take the newest |
   | Risk hint `bin_exposed` | yes (under `--fail-on-risk`) | Informational: a bin is contained, proceed | drop `--fail-on-risk`, then `sandbox install` |
   | Advisory, **non-malware** (`advisory <ids>`) | **no, warn only** | Surface it; there's no flag that blocks on it | (see note) |

   **Safe install (default, `add` only):** when a `sandbox add <pkg>` would pull a freshly-published
   version (inside the worm window) and an older release predates it, sandbox installs the older release
   and pins it exact, printing a `safe install:` receipt. You usually do not need to intervene on a
   freshness finding for an `add`: it is already handled. To take the newest as typed, add
   `--allow-recent <pkg>`; to turn the behaviour off, set `install.safeInstall: false`. It never silently
   swaps past malware, a typosquat, or a build-breaking major bump; those still surface or block.

   **Non-malware advisory caveat:** these never change the exit code. `check` still
   reports them (in `advisoryHits[]`) without installing, so you can surface one and let the
   user decide before step 4. There is no dedicated "block on any advisory" flag, so say so
   plainly rather than implying one exists.

4. **Install with the user's choices.** The review pass installed nothing; this step runs.
   Apply only the overrides they approved:
   - Clean pass (exit 0) → `sandbox install [pkgs]` (or `sandbox add <pkg>`)
   - Approve one fresh package, keep the gate for the rest → `sandbox --allow-recent left-pad install`
   - Accept all fresh releases this once → `sandbox --min-release-age 0 install`
   - Pin instead of install-latest → run the `pin` command from `suggestions[]`
     (`sandbox add <pkg>@<version>`)
   - Abort → stop; nothing was installed.

   **If the install itself blocks on egress** (not a review finding; a `postinstall` tried to
   reach a host that isn't on the allowlist), the proxy reports the blocked host. When it's a known
   **build host** (Node headers, GitHub releases, Prisma/Playwright/Cypress/Puppeteer/Electron
   binaries), re-run with `--allow-build-hosts`: it adds the curated native-build hosts for that run
   and **stays a default-deny allowlist** (not full network). Prefer the narrowest fix: allow
   the exact host with `sandbox allow <host>` when only one is needed.

   **If pnpm stops for dependency build-script approval** (`allowBuilds` placeholders in
   `pnpm-workspace.yaml`), keep the decision inside sandbox:
   - On a TTY, let `sandbox` prompt and re-run.
   - Non-interactive: run `sandbox approve-builds` (all pending) or
     `sandbox approve-builds <pkg...>` (specific packages).
   - For an unattended run the user has already approved, add `--allow-all-builds`.
   - If the user wants to reject one, run `sandbox approve-builds --deny <pkg>`.

   **One mode per project.** A contained install rebuilds `node_modules` as a Linux tree, so a
   project is in exactly one mode at a time, never both: LOCAL (host-native, from the user's own
   `pnpm install`) or CONTAINER (the Linux tree a contained install writes). sandbox tells them apart
   by the native binaries in the tree, read live (a host-native tree has packages built for the host
   OS), so the signal can't go stale after a host install. If the project already
   has a host-native tree, the first contained install warns before clobbering it: on a TTY it asks
   you to confirm the switch; in CI / non-TTY (an agent) it logs the warning and proceeds. To keep a
   project local, run the user's own `pnpm install` instead. To run host tools or a host IDE against
   a container tree, run them through `sandbox` (e.g. `sandbox test`, `sandbox dev`), or switch the
   project to local with a plain host install (remove `node_modules` first). `sandbox devcontainer
   init` is the persistent form: it keeps `node_modules` in a Docker volume so the boundary and a
   happy IDE come together.

5. **Report** exactly what ran, which overrides were applied and why, and what installed.

## Rules

- **Never auto-proceed past a `MAL-…` malware advisory.** Always stop and make the user
  type the override themselves if they insist.
- **Every override must be a real flag** the user approved; never silently relax the gate.
- **Lead with `sandbox install` / `sandbox add` / `sandbox update`.** sandbox detects the package
  manager (npm/pnpm/yarn/bun) from the project, so you don't name it. The per-PM binaries
  (`spnpm`, …) are an expert shortcut for the same mode-aware path.
- For `package.json` scripts, prefer `sandbox <script>` over `sandbox <pm> run <script>`, and use
  `sandbox script <name>` when the script name collides with a sandbox command.
- Prefer the narrowest override (`--allow-recent <pkg>`) over the blanket one
  (`--min-release-age 0`). Same for egress: `sandbox allow <host>` (one host) before
  `--allow-build-hosts` (the curated bundle) before `--full-network` (no allowlist at all).
- For pnpm build scripts, prefer `sandbox approve-builds <pkg>` over `--allow-all-builds` when the
  user only trusts a small set of packages.
- Non-interactive / CI / "just set it up": skip the prompts and pick the strict default
  (abort on any finding) unless the user pre-stated their tolerance, then encode it as flags.

## Expert: per-PM binaries (same mode-aware path, shorter keystrokes)

The default `sandbox install` / `add` / `update` commands cover everyone. For a human who lives in
their package manager's muscle memory, the per-PM binaries take the same mode-aware path without the
`sandbox` prefix or the auto-detect step: `sandbox-pnpm add zod` (short alias `spnpm add zod`) is the
same keystrokes as `pnpm add zod`, but it vets with the gate engine and installs mode-aware (native on
a host-native or fresh project, contained when the tree already is).
Use explicit `sandbox <pm>` when you want the throwaway container boundary.

- Binaries: `sandbox-npm`/`snpm`, `sandbox-pnpm`/`spnpm`, `sandbox-yarn`/`syarn`, `sandbox-bun`/`sbun`,
  `sandbox-npx`/`snpx`, `sandbox-bunx`/`sbunx`.
- The real `npm`/`pnpm` is never shadowed; the user opts in by typing the prefix.
- Use the explicit `sandbox <pm> …` form when you want to name the package manager rather than rely
  on detection (e.g. mixed-toolchain repos). It takes the same gate flags as everything above.

See [REFERENCE.md](REFERENCE.md) for the full flag list and finding formats.

## Related skills

- **sandbox-agent-isolation**: contain the *agent* that runs installs (host PreToolUse hook via `sandbox init --agent`, or run the whole session inside a `sandbox devcontainer`).
- **sandbox-ci**: the read-only, no-Docker CI/cron gates: `verify`, `delta` (gate only a PR's dependency changes), `scan` (retroactive malware sweep), `secrets`.
