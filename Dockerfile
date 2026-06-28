# NODE_BASE lets `build.baseImage` / `build.nodeVersion` swap the base without editing this
# file (passed as a --build-arg). Keep the default in sync with DEFAULT_BASE_IMAGE in image.ts.
ARG NODE_BASE=node:24-bookworm-slim
FROM ${NODE_BASE}

# Native-build toolchain so node-gyp / binding.gyp dependencies compile INSIDE
# the sandbox (the exact vector behind the 2026-06-04 Miasma incident). The point
# is not to block native builds — it's to make them happen here, not on your host.
# iproute2 + libcap2-bin back the metadata guard (net-guard.sh): in "on" mode it
# blackholes the cloud-metadata IP then drops every capability before your command.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates git iproute2 libcap2-bin \
  && rm -rf /var/lib/apt/lists/*

# Metadata guard — only invoked (via --entrypoint) when the container runs on the
# default bridge ("on"/open). Isolated and allowlist-proxy modes don't need it.
COPY net-guard.sh /usr/local/bin/sbx-net-guard
RUN chmod +x /usr/local/bin/sbx-net-guard

RUN corepack enable
# Pre-activate pnpm + yarn classic so installs don't download a package manager at run time
# (faster, and works under the no-network/allowlist phases). Also prefetch one modern
# Yarn Berry for `yarn dlx` in lockfile-only repos, where no packageManager pin exists
# yet to tell corepack what to bake. Silence the prompt.
# A project that pins a *different* pnpm/yarn via package.json "packageManager" gets
# that exact version baked as an extra build layer (see corepackPrepareStep in image.ts),
# so corepack never has to fetch one through the egress proxy at run time.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack prepare pnpm@9.15.0 yarn@1.22.22 --activate
RUN corepack prepare yarn@4.14.1

# Bun ships as a standalone binary (not via corepack). Install it at build time so
# `sandbox bun install/add` runs under the same no-network/allowlist phases as the
# others, without fetching a package manager at run time.
RUN npm install -g bun@^1.2.0 && bun --version

WORKDIR /workspace

# Runs as root *inside an isolated, credential-free container*. container-root is
# not host-root, and we drop all Linux capabilities + no-new-privileges at run
# time. On Linux hosts add `--user $(id -u):$(id -g)` to avoid root-owned files on
# bind mounts; on macOS Docker Desktop (VirtioFS) this is handled for you.
CMD ["bash"]
