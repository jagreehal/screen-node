---
title: Isolate a coding agent
description: Contain the agent that runs your installs. A host PreToolUse hook blocks bare npm/npx, or a generated devcontainer runs the whole session in the jail.
---

sandbox contains installs. This contains the **agent that runs them**. Same policy, two lifecycles.

- **Ephemeral.** The agent works on the host; each dangerous command is jailed the moment it runs. A `PreToolUse` hook enforces it, so the agent can't run a bare install. Set up with `sandbox init --agent`.
- **Persistent.** The agent and editor run inside a hardened container for the whole session; nothing dangerous touches the host because the host isn't reachable. Generated with `sandbox devcontainer init`.

Pick ephemeral to keep your host agent working with the risky commands gated. Pick persistent for maximum isolation on an untrusted repo.

## Ephemeral: gate the host agent

```bash
sandbox init --agent      # or: sandbox setup --agent
```

This writes:

- `sandbox.config.json` with the `agent` preset (blocking release-age gate, canaries on, host credentials still out).
- `.sandbox/AGENT.md`: instructions to paste into the agent's project rules.
- A `PreToolUse` hook wired into `.claude/settings.json` that **enforces** them and denies the agent reading `.env` and secrets.

The hook blocks any bare package-manager install/exec or fetch-and-run runner (`npm/pnpm/yarn/bun install · add · run · exec · update · uninstall · …`, bare `yarn`, and `npx/pnpx/bunx`) and tells the agent to re-run it through `sandbox`, leading with `sandbox install`, `sandbox add <pkg>`, or `sandbox update`. Read-only queries (`npm ls`, `npm view`) stay allowed.

:::caution[Enforcement beats instructions]
`.sandbox/AGENT.md` only *asks*. The hook *enforces*. Setup prints whether `.claude/settings.json` was wired; if it says the file wasn't valid JSON, the hook is **not** active. Fix that file and merge the printed snippet, or you only have advice.
:::

## Persistent: agent inside the jail

```bash
sandbox devcontainer init      # --force to overwrite an existing .devcontainer/
```

It generates a hardened `.devcontainer/` from the **same** `sandbox.config.json`: a pinned base image, a non-root user, the same default-deny `egress.allow`, plus the domains the agent itself needs to run inside.

:::caution[Inside the devcontainer, run plain `npm install`]
Not `sandbox npm install`. The whole environment already *is* the sandbox; nesting a second container would need the Docker socket (host root) and defeat the point. Update `.sandbox/AGENT.md` so the agent knows this when it's running inside.
:::

## One policy, two lifecycles

Both read `sandbox.config.json`. Change the boundary once (egress, grants, preset) and regenerate the devcontainer. Don't maintain two configs. Keep grants minimal: the `agent` preset keeps host credentials out by default, so add a grant only when the agent needs it.

:::note[There's a skill for this]
The `sandbox-agent-isolation` skill walks an agent through both lifecycles. It ships in the package under `skills/`.
:::
