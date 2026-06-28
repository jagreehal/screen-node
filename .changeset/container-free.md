---
"@jagreehal/screen-node": major
---

Make screen-node genuinely container-free. The inherited Docker/container subsystem (image build, egress proxy, network firewall, devcontainer, demo, agent PreToolUse hook) has been removed. Every install/add/update/remove now runs the supply-chain gate engine first, then installs natively on the host. Removed the `build`, `demo`, `devcontainer`, and `shell` commands and the `--backend`/`--image` container config fields; `run`/`x`/`audit` now pass through natively.
