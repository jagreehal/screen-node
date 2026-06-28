# Examples

Runnable mini-projects that do more than show syntax: they check that each package
manager routes through the right containment model, and in `--real` mode they fetch a
real registry dependency while a malicious local `postinstall` probe tries to break the
boundary.

> These are **not** part of the published package (`package.json#files` ships only
> `dist/`, the Dockerfile, the proxy, the schema, and the README). Nothing here is
> distributed to npm consumers.

## Layout

| Folder | Proves |
| --- | --- |
| [`npm/`](./npm) | `sandbox npm install` plans npm with read-only persistence paths and allowlist egress |
| [`pnpm/`](./pnpm) | `sandbox pnpm install` plans pnpm via corepack with the same containment |
| [`yarn/`](./yarn) | `sandbox yarn install` plans yarn via corepack, with `registry.yarnpkg.com` added because yarn's registry is not npm's |
| [`bun/`](./bun) | `sandbox bun install` plans the standalone bun binary with the same boundary |
| [`workspace/`](./workspace) | install runs at the workspace root while `run` stays in the package dir you invoked from |
| [`react-vite/`](./react-vite) | dev server with HMR: `sandbox dev` forwards port 5173, `HOST=0.0.0.0` auto-set by the sandbox so the container-bound dev server is reachable from the host |

Each folder is a tiny project with:

- one real registry dependency (`is-odd`) so the package manager has to fetch normally
- one local dependency (`./bad-dep`) whose `postinstall` probe fails if it can
  see host creds, create `.github/`, or reach `https://example.com`

> The [`react-vite/`](./react-vite) example uses a different pattern: it depends on real
> packages (`react`, `vite`) and proves the dev-server path — `HOST=0.0.0.0` binding,
> port 5173 forwarding, and HMR injection.

Put `sandbox` in front of the command you already know:

```bash
cd examples/bun
sandbox bun install        # bun runs in the sandbox; your secrets stay on the host
```

## Proof without Docker

`run.mjs` asks each example for its resolved execution plan (`--json`) and asserts:

- the right package manager is invoked
- install egress stays on `allowlist`
- `package.json` and persistence paths are read-only
- `HOME=/root`, `cap-drop ALL`, and `no-new-privileges` are in effect
- fetch-and-run commands (`npx`/`dlx`/`bunx`) still route through the `run` model, but
  pick up install-class registry allowlist networking so package fetch fallback works by default
- workspace installs resolve to the repo root while `run` stays in the leaf package dir
- the React+Vite dev server plan sets `HOST=0.0.0.0` so the container-bound server is reachable
  from the host, and port 5173 is forwarded

This is fast and needs no container runtime:

```bash
npm run build              # produce dist/cli.js first
node examples/run.mjs
```

## Proof for real (needs Docker or Podman)

Add `--real` to actually run every install inside a container. In this mode an example
passes only if:

- the real dependency installs
- the malicious `postinstall` probe actually runs
- the probe cannot see host creds, cannot create `.github/`, and cannot egress
- a follow-up `--frozen` install resolves to the package-manager-specific reproducible
  mode and succeeds with the seeded lockfile
- fetch-and-run commands work on the default registry allowlist, with no extra run-network override
- from a workspace package, install happens at the root but `run` executes in the package dir
- the React+Vite example installs React and Vite through the sandbox, and the dev server
  is reachable on `http://localhost:5173` with HMR active

```bash
node examples/run.mjs --real
```
