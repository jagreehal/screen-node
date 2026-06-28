---
name: sandbox-ci
description: Harden a repo's CI/cron with the read-only, no-Docker gates of the `sandbox` CLI (@jagreehal/sandbox-node) — `verify` (the sandbox boundary is committed and un-loosened), `delta` (gate only the dependency changes a PR introduces), `scan` (retroactive malware sweep over the committed lockfile), `secrets` (committed-credential tripwire), and signed `verify --sign` receipts. Use when the user wants a CI gate for supply-chain risk, a PR check for new dependencies, a scheduled malware re-scan, a committed-secret check, a "sandboxed" badge, or asks to "add sandbox to CI" / "gate dependency changes".
---

# sandbox-ci

These commands are the CI/cron half of sandbox: **read-only, no container, no Docker.** Each is a tripwire — it exits non-zero on a real problem, so it drops straight into a CI step. None of them install anything.

Pick by what you're gating:

| Want to gate | Command | Exits non-zero when |
|---|---|---|
| The boundary itself is real and committed | `sandbox verify` | the repo doesn't commit a genuine sandbox boundary, or a personal layer loosened it |
| Only what a PR's dependency change introduces | `sandbox delta` | an added/bumped version trips the release-age / malware / deprecation gate |
| Already-installed deps that turned malicious later | `sandbox scan` | any version in the committed lockfile is NOW flagged as malware (OSV) |
| Credentials committed to the repo | `sandbox secrets` | any API key / token / private key / db URL is found (value redacted) |

## Recipes

- **PR check — gate only the change (low-noise, the one to reach for first):**
  ```
  sandbox delta --min-release-age 7 --fail-on-advisory
  ```
  Diffs the lockfile against the merge base (default `origin/main`; `--base <ref>` or `--base-lockfile <path>` to override) and runs the gates over just the added/bumped versions. A bare `sandbox check`/`preflight` re-gates *every* dependency, which trips release-age on already-vetted committed packages — noise, not new risk. Use `delta` for PRs; reserve full `check` for when you're genuinely adding packages (see the `sandbox-install` skill).

- **Scheduled malware re-scan (cron/nightly):**
  ```
  sandbox scan
  ```
  Re-queries OSV for the versions you already have installed. Catches dependencies that turned malicious *after* you installed them — the gap install-time gating can't cover. No Docker.

- **Committed-secret tripwire:**
  ```
  sandbox secrets        # defaults to cwd; pass a path to scope it
  ```
  Offline, ~40 provider patterns with checksum/decode validation (Luhn, JWT) to cut noise. Reports *where*, never the secret. The sandbox keeps host secrets OUT of installs; this catches the other half — a key committed into the repo.

- **Boundary gate (and the badge it backs):**
  ```
  sandbox verify              # fail unless a real, un-loosened boundary is committed
  sandbox verify --scan       # also run the retroactive malware sweep
  sandbox verify --secrets    # also fail if a credential is committed
  ```
  `verify --scan --secrets` makes a green run mean "boundary intact AND no installed dep is currently flagged AND no secret committed." `sandbox badge` prints the markdown badge; `--workflow sandbox.yml` makes it the CI-backed verified badge.

- **Signed receipts (attest a green boundary):**
  ```
  sandbox keygen                                   # Ed25519 keypair: private → CI secret
  SANDBOX_SIGNING_KEY=key sandbox verify --sign     # emits a signed receipt to stdout (only if every gate passed)
  sandbox verify-receipt receipt.json --fingerprint <hex>   # verify; pin the signer
  ```
  `--sign` refuses to sign if any requested check failed, so a receipt can never attest a green boundary over a red one.

## Rules

- **These are tripwires — wire them to fail the job.** Don't swallow the exit code; the non-zero IS the gate.
- **`delta` for PRs, `check`/`preflight` for genuinely-new packages, `scan` for cron.** Using a full `check` as a PR gate on an active project produces release-age noise on already-vetted deps; reach for `delta`.
- **No Docker needed** for any command here — they query the registry/OSV and read files. Don't add a container step.
- **Tighten with the same flags as install:** `--min-release-age <days>`, `--fail-on-advisory`, `--fail-on-risk`. The `strict` preset sets sensible CI defaults (`sandbox init --preset strict`).
- **When a CI step runs the real install in the container** (e.g. `sandbox npm ci`), add `--fail-on-source-writes` (config `install.failOnSourceWrites`, on in `strict`): it fails the job if the install edited your source tree outside deps/lockfiles. The edit still happened (the tree is writable) — this is a detect-and-fail tripwire, and the changed files are also in the audit log as an `install.source-write` event. Unlike the gates above, this one needs the container.
- **A non-malware advisory never changes the exit code** (same as the install path) — there's no "block on any advisory" flag. Say so plainly rather than implying one exists.
- **`verify` is about the committed boundary, not a live run** — it's how you stop a PR from quietly loosening containment for the whole team.

See [`docs/reference.md`](../../docs/reference.md) for the full flag list, the receipt/audit-log format, and CI workflow examples.
