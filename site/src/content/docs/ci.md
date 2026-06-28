---
title: Gate dependencies in CI
description: The read-only, no-Docker gates that drop into CI and cron, covering verify, delta, scan, secrets, and signed receipts.
---

These commands are read-only, need no container, and exit non-zero on a real problem, so each drops straight into a CI step. None of them install anything.

| Gate | Command | Fails when |
| --- | --- | --- |
| The boundary is real and committed | `sandbox verify` | the repo doesn't commit a genuine boundary, or a personal layer loosened it |
| Only a PR's dependency change | `sandbox delta` | an added/bumped version trips the release-age, malware, or deprecation gate |
| Already-installed deps gone bad | `sandbox scan` | a version in the committed lockfile is now flagged as malware |
| Committed credentials | `sandbox secrets` | an API key, token, or private key is found (value redacted) |

## PR check: gate only the change

```bash
sandbox delta --min-release-age 7 --fail-on-advisory
```

Diffs the lockfile against the merge base (default `origin/main`; `--base <ref>` to override) and gates only what the PR added or bumped. Reach for this rather than a full `check` on a pull request: `check` re-gates every dependency and trips release-age on already-vetted packages.

## Scheduled malware re-scan

```bash
sandbox scan
```

Re-queries OSV for the versions you already have installed. It catches dependencies that turned malicious *after* you installed them, the gap install-time gating can't cover. Run it nightly.

## Committed-secret tripwire

```bash
sandbox secrets
```

Offline, around 40 provider patterns with checksum and decode validation to cut noise. It reports *where*, never the secret. The sandbox keeps host secrets out of installs; this catches the other half, a key committed into the repo.

## The boundary gate and its badge

```bash
sandbox verify --scan --secrets
```

A green run now means: the boundary is committed and un-loosened, no installed dependency is currently flagged, and no credential is committed. `sandbox badge --workflow sandbox.yml` prints the CI-backed "sandboxed" badge.

## Signed receipts

```bash
sandbox keygen                                    # Ed25519 keypair: private key → CI secret
SANDBOX_SIGNING_KEY=key sandbox verify --sign     # signed receipt to stdout, only if every gate passed
sandbox verify-receipt receipt.json --fingerprint <hex>
```

`--sign` refuses to sign if any requested check failed, so a receipt can never attest a green boundary over a red one.

:::note
A non-malware advisory never changes the exit code, same as the install path. There's no "block on any advisory" flag; `scan` and `delta` block on **malware** and surface the rest.
:::
