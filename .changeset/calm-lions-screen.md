---
'@jagreehal/screen-node': minor
---

Add a `nub-screen` executable for Nub's plugin protocol. Installing screen-node now enables
`nub screen check`, `scan`, `delta`, `secrets`, `verify`, and the other complementary security
commands. Nub retains ownership of installation, execution, and build approval, and the plugin
rejects those verbs with guidance instead of running another package manager.

Add a default-trust floor for pnpm build scripts. A short curated list of native-build packages can
run without a prompt after the exact lockfile version clears registry provenance, OSV malware, and
release-age checks. Multiple versions and unavailable checks fall back to human approval. The
`strict` preset keeps manual approval for every build script.

Add `--fail-on-degraded` and `install.failOnDegraded` for users who want registry or OSV outages to
block an install. Degraded gates remain visible when the default fail-open policy allows the install.

Cache empty OSV verdicts for repeated frozen installs of the same lockfile and gate policy. Entries
expire after 24 hours, and changed lockfiles, findings, or degraded checks cannot reuse or create a
verdict.

Rework the README around installation, command aliases, benefits, and Nub integration. It separates
Nub's install-time enforcement from screen-node's repository and policy checks and documents the
direct `nub-screen` fallback for Nub builds without plugin resolution.
