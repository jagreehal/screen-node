---
name: sandbox-agent-isolation
description: Contain a coding agent (Claude Code, Cursor, Codex, …) so the package-manager and dependency code it runs can't touch host credentials, persistence, or the network — using the `sandbox` CLI (@jagreehal/sandbox-node). Covers the two lifecycles: ephemeral (agent on the host, every dangerous command jailed by a PreToolUse hook via `sandbox init --agent`) and persistent (agent + editor INSIDE a hardened devcontainer via `sandbox devcontainer init`). Use when the user wants to run an AI coding agent safely, stop an agent from running bare `npm install`/`npx`, isolate an untrusted repo or agent session, or asks to "sandbox my agent" / "lock down Claude in this repo".
---

# sandbox-agent-isolation

`sandbox` vets installs and can quarantine them in a throwaway container. This skill isolates the **agent that drives the installs**, where the container isn't optional, it's the point. There are two lifecycles for the same policy (both read the same `sandbox.config.json`):

- **Ephemeral**: the agent runs on the host; each dangerous command (`npm install`, `npx …`, …) is jailed in the container at the moment it runs. A `PreToolUse` hook *enforces* it: the host agent literally cannot run a bare install/exec, it's denied before it executes, and rewritten to the contained form. Set up with `sandbox init --agent`.
- **Persistent**: the agent + editor run INSIDE a hardened container for the whole session; nothing dangerous touches the host because the host isn't reachable. Generated with `sandbox devcontainer init`.

Pick ephemeral for "let my host agent keep working, just gate the risky commands." Pick persistent for "run the whole session in a box" (untrusted repo, maximum isolation).

## Ephemeral: gate the host agent (`sandbox init --agent`)

1. **Set it up.** `sandbox init --agent` (or `sandbox setup --agent` for the full onboarding). It writes:
   - `sandbox.config.json` with the `agent` preset (blocking release-age gate, canaries on, project-local Claude config, host credentials still out).
   - `.sandbox/AGENT.md`: advisory instructions to paste into the agent's project rules ("use `sandbox install` / `sandbox add <pkg>`, not bare `npm install` / `npm install <pkg>`"; "don't ask for host credentials").
   - A `PreToolUse` hook wired into `.claude/settings.json` that **enforces** the above and denies the agent reading `.env`/secrets.
2. **Confirm the hook wired.** Setup prints whether `.claude/settings.json` was wired. If it says the file wasn't valid JSON, the hook is NOT active: fix that file and merge the printed snippet, or enforcement is only advisory.
3. **What the hook blocks.** Any bare package-manager install/exec or fetch-and-run runner: `npm/pnpm/yarn/bun` with `install`/`i`/`ci`/`add`/`run`/`exec`/`update`/`uninstall`/`dlx`/`create`/… , bare `yarn` (= install), and `npx`/`pnpx`/`bunx`. It is denied with a message telling the agent to re-run it through `sandbox`, leading with the default write path: `sandbox install`, `sandbox add <pkg>`, or `sandbox update`. Use the explicit `sandbox <pm> …` form only when naming the package manager matters. Read-only queries (`npm ls`, `npm view`, `npm outdated`) are deliberately allowed.
4. **What it does NOT block.** Anything already prefixed with `sandbox`, and reading non-secret files. The hook governs the agent on the host; it is the lightweight half.

## Persistent: agent inside the jail (`sandbox devcontainer init`)

1. **Generate it.** `sandbox devcontainer init` (add `--force` to overwrite an existing `.devcontainer/`). It emits a hardened `.devcontainer/` from the SAME `sandbox.config.json`: pinned base image (by digest when the registry is reachable), non-root user, the same default-deny `egress.allow`, plus the domains Claude Code itself needs to run inside (inference, auth, updates).
2. **The rule once inside:** run **plain** `npm install` / `pnpm add`, **NOT** `sandbox install` or `sandbox npm install`. The whole environment already *is* the sandbox; nesting a second container would need the Docker socket (host root) and defeat the point. (Update `.sandbox/AGENT.md` so the agent knows this when it's running inside.)
3. **Egress still applies inside.** If a tool in the container is blocked reaching a host, widen `egress.allow` in `sandbox.config.json` and regenerate; the same allowlist drives both lifecycles.

## Rules

- **Enforcement > instructions.** `.sandbox/AGENT.md` only *asks*; the PreToolUse hook *enforces*. If the user wants real isolation on the host, the hook must be wired (step 2). Say so plainly; don't imply AGENT.md alone is a boundary.
- **Ephemeral and persistent are one policy, two lifecycles.** Both read `sandbox.config.json`. Change the boundary once (egress, grants, preset) and regenerate the devcontainer; don't maintain two configs.
- **Inside a devcontainer, never prefix with `sandbox`.** On the host, lead with `sandbox install` / `sandbox add` / `sandbox update` (or rely on the hook to prefix bare commands). This is the single most common confusion; state it explicitly.
- **Grants stay minimal.** The `agent` preset keeps host credentials out by default. Add a grant (`ssh-agent`, a path, an env var) only when the user asks, and prefer `ssh-agent` over mounting key files.
- **Verify the boundary is committed**, not just present locally: `sandbox verify` (see the `sandbox-ci` skill) fails if the repo's boundary was loosened. Good for a repo that hands work to agents.

See [`docs/reference.md`](../../docs/reference.md) for the full hook, devcontainer, preset, and config surface.
