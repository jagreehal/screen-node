import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { generateSigningKey, keyFingerprint, readAuditLog, signPayload, verifyChain, verifyReceipt, type ChainVerdict, type SignedReceipt } from './receipt.js';

export interface VerifyResult {
  ok: boolean;
  /** What was verified (effective boundary) — printed so the CI log shows the policy. */
  summary: string[];
  /** Why it failed, if it did. Empty on success. */
  problems: string[];
}

/**
 * The check behind the verified badge: confirm this repo commits a real sandbox boundary and
 * that no personal layer has loosened it. Designed to run in CI as an exit-code gate — green
 * means "installs here actually go through a default-deny sandbox," which is what the badge claims.
 */
export function verifyConfig(cwd: string, configPath?: string): VerifyResult {
  const summary: string[] = [];
  const problems: string[] = [];

  // Resolve the project config the same way readConfig/loadConfig do, so a caller that passes only
  // `cwd` still finds `cwd/screen.config.json`. The gate fails only when that file truly doesn't exist.
  const projectFile = configPath ?? path.join(cwd, 'screen.config.json');
  if (!existsSync(projectFile)) {
    return { ok: false, summary, problems: [`no committed screen.config.json found at ${projectFile}, run \`screen init\` and commit it`] };
  }

  let loaded;
  try {
    loaded = loadConfig(cwd, projectFile);
  } catch (e) {
    return { ok: false, summary, problems: [e instanceof Error ? e.message.replace(/^screen:\s*/, '') : String(e)] };
  }

  // A personal layer (user-global or *.local.json) loosening past the committed boundary fails
  // the gate — that's the un-reviewed widening the badge must not vouch for.
  for (const w of loaded.warnings) problems.push(`boundary loosened beyond committed config: ${w}`);

  const c = loaded.config;
  summary.push(
    `install network : ${c.install.network}`,
    `run network     : ${c.run.network}`,
    `egress allow    : ${c.egress.allow.join(', ') || '(none)'}`,
    `credential grants: ${grantsSummary(c)}`,
  );
  return { ok: problems.length === 0, summary, problems };
}

function grantsSummary(c: ReturnType<typeof loadConfig>['config']): string {
  const g = c.grants;
  const on = [
    ...(g['ssh-agent'] ? ['ssh-agent'] : []),
    ...(g.claude !== 'none' ? [`claude:${g.claude}`] : []),
    ...(g.paths.length ? [`paths×${g.paths.length}`] : []),
    ...(g.env.length ? [`env×${g.env.length}`] : []),
    ...(g.envFiles.length ? [`envFiles×${g.envFiles.length}`] : []),
  ];
  return on.length ? on.join(', ') : 'none';
}

/** CLI entry: print the verdict and return an exit code (0 = boundary verified). */
export function runVerify(cwd: string, configPath?: string): number {
  const { ok, summary, problems } = verifyConfig(cwd, configPath);
  for (const line of summary) log.info(`  ${line}`);
  if (ok) {
    log.info('verified: installs run through a committed screen boundary');
    return 0;
  }
  for (const p of problems) log.error(p);
  return 1;
}

/** What a signed verify receipt attests: the boundary that was verified, which gates passed, and when. */
export interface VerifyReceiptPayload {
  ok: true;
  /** The same effective-boundary lines `verify` prints, so the receipt records exactly what was vouched for. */
  summary: string[];
  /**
   * The checks that PASSED and are therefore attested by this receipt — always `boundary`, plus
   * `scan` (no installed dep currently flagged as malware) and/or `secrets` (no committed credential)
   * when those gates were run. A reader can see the exact scope: a receipt that lists only `boundary`
   * does NOT vouch for malware/secret cleanliness, and says so by omission.
   */
  checks: string[];
  verifiedAt: string;
}

/**
 * Sign a GREEN verify result so a third party can confirm it without re-running the gates.
 * Deliberately refuses to sign anything that didn't pass — a receipt exists only to attest a real
 * pass, so a caller can treat "a valid receipt exists" as "every attested check held". The caller is
 * responsible for running the extra gates named in `checks` and only calling this once they ALL
 * passed; we re-verify the boundary here as a backstop and return null if it regressed.
 */
export function signVerifyReceipt(cwd: string, privateKeyPem: string, opts: { configPath?: string; now: Date; checks: string[] }): SignedReceipt<VerifyReceiptPayload> | null {
  const { ok, summary } = verifyConfig(cwd, opts.configPath);
  if (!ok) return null;
  return signPayload<VerifyReceiptPayload>({ ok: true, summary, checks: opts.checks, verifiedAt: opts.now.toISOString() }, privateKeyPem);
}

/** Read a private signing key from a PEM file, with a clear error if it's missing/unreadable. */
export function readSigningKey(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new Error(`couldn't read signing key at ${file}, generate one with \`screen keygen\` and point SANDBOX_SIGNING_KEY at the private half`);
  }
}

/** `sandbox keygen` — mint an Ed25519 signing keypair and print it (keys to stdout, guidance to stderr). */
export function runKeygen(opts: { json?: boolean } = {}): number {
  const { publicKeyPem, privateKeyPem } = generateSigningKey();
  const fingerprint = keyFingerprint(publicKeyPem);
  if (opts.json) {
    console.log(JSON.stringify({ fingerprint, publicKeyPem, privateKeyPem }, null, 2));
    return 0;
  }
  // Keys go to stdout so the user pipes each half where it belongs; guidance goes to stderr (log.*).
  log.info('Ed25519 signing keypair, store the PRIVATE key as a CI secret, commit/pin the fingerprint:');
  log.info(`  fingerprint: ${fingerprint}  (set SANDBOX_TRUSTED_KEY to this to pin the signer)`);
  log.info('  private key → point SANDBOX_SIGNING_KEY at a file holding it, and NEVER commit it');
  console.log(privateKeyPem.trimEnd());
  console.log(publicKeyPem.trimEnd());
  return 0;
}

/** `sandbox audit verify <log>` — confirm the hash chain is intact. Returns an exit code (0 = intact). */
export function runAuditVerify(file: string, opts: { json?: boolean } = {}): number {
  let verdict: ChainVerdict;
  try {
    verdict = verifyChain(readAuditLog(file));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (opts.json) console.log(JSON.stringify({ ok: false, reason }));
    else log.error(`audit: ${reason}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(verdict, null, 2));
    return verdict.ok ? 0 : 1;
  }
  if (verdict.ok) {
    log.info(`audit: chain intact, ${verdict.length} entr${verdict.length === 1 ? 'y' : 'ies'}, no tampering detected`);
    return 0;
  }
  log.error(`audit: chain BROKEN at seq ${verdict.brokenAt}, ${verdict.reason}`);
  return 1;
}

/** Verify a receipt file, optionally pinning the signer's fingerprint. Returns an exit code (0 = trusted + valid). */
export function runVerifyReceipt(file: string, opts: { trustedFingerprint?: string; json?: boolean } = {}): number {
  let receipt: SignedReceipt<VerifyReceiptPayload>;
  try {
    receipt = JSON.parse(readFileSync(file, 'utf8')) as SignedReceipt<VerifyReceiptPayload>;
  } catch (e) {
    if (opts.json) console.log(JSON.stringify({ ok: false, reason: `couldn't read receipt: ${e instanceof Error ? e.message : String(e)}` }));
    else log.error(`couldn't read receipt at ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const verdict = verifyReceipt(receipt, { trustedFingerprint: opts.trustedFingerprint });
  if (opts.json) {
    console.log(JSON.stringify({ ...verdict, payload: receipt.payload }, null, 2));
    return verdict.ok ? 0 : 1;
  }
  if (verdict.ok) {
    log.info(`receipt verified (signer ${verdict.fingerprint}), boundary attested at ${receipt.payload.verifiedAt}`);
    for (const line of receipt.payload.summary) log.info(`  ${line}`);
    return 0;
  }
  log.error(`receipt INVALID: ${verdict.reason}`);
  return 1;
}
