import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/**
 * Tamper-evident evidence for the sandbox boundary. Two independent mechanisms, both built on
 * `node:crypto` (zero new dependencies):
 *
 *   1. A HASH-CHAINED audit log (JSONL). Each entry carries the hash of the one before it, so the
 *      ledger is append-only by construction: edit or drop any past line and every later hash stops
 *      matching. This is the "what crossed the boundary, in order" record a reviewer can trust wasn't
 *      rewritten after the fact.
 *   2. An ED25519-SIGNED verify receipt. `sandbox verify` proves a boundary is committed; the signed
 *      receipt lets a THIRD PARTY confirm that proof without re-running it — the signature is made by
 *      a key the agent/CI never has to expose, preserving clean separation between signer and verifier.
 *
 * Honest scope: a hash chain proves INTERNAL consistency (no entry was altered in place). It does not
 * stop someone discarding the whole file and starting a fresh one — for that you pin the latest hash
 * (or sign a checkpoint) somewhere out of band. The signed receipt covers the boundary it names and
 * nothing more. We say so plainly rather than implying the file is unforgeable.
 */

/** The prev-hash sentinel for the first entry in a chain. */
export const GENESIS = 'genesis';

/**
 * Deterministic JSON: object keys sorted recursively so identical content always serialises
 * byte-for-byte the same way. Hashing and signing both depend on this — `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` are the same fact and must produce the same digest. Arrays keep their order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ───────────────────────────── hash-chained audit log ─────────────────────────────

/** One link in the audit chain. `hash` covers the whole entry-minus-hash AND the previous hash. */
export interface AuditEntry {
  seq: number;
  /** RFC 3339 timestamp. Passed in by the caller (the chain must stay deterministic for tests). */
  ts: string;
  /** Short event kind, e.g. `install.blocked`, `egress.denied`, `canary.exfil`, `verify`. */
  event: string;
  detail?: Record<string, unknown>;
  /** Hash of the previous entry, or {@link GENESIS} for the first. */
  prevHash: string;
  hash: string;
}

/** The fields the hash commits to: everything except `hash` itself. Linking in `prevHash` is what chains them. */
function entryDigest(fields: Omit<AuditEntry, 'hash'>): string {
  return sha256Hex(canonicalize(fields));
}

/** Build the next entry in a chain given the previous one (or undefined for the first). Pure. */
export function chainEntry(prev: AuditEntry | undefined, ts: string, event: string, detail?: Record<string, unknown>): AuditEntry {
  const fields: Omit<AuditEntry, 'hash'> = {
    seq: prev ? prev.seq + 1 : 0,
    ts,
    event,
    ...(detail && Object.keys(detail).length ? { detail } : {}),
    prevHash: prev ? prev.hash : GENESIS,
  };
  return { ...fields, hash: entryDigest(fields) };
}

/** Parse a JSONL audit log into entries. Missing file → empty chain. Throws on a malformed line. */
export function readAuditLog(file: string): AuditEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((line, i) => {
      try {
        return JSON.parse(line) as AuditEntry;
      } catch {
        throw new Error(`audit: malformed JSON on line ${i + 1} of ${file}`);
      }
    });
}

/**
 * Append one event to the JSONL audit log, chaining it to the current tail. Best-effort by design —
 * audit evidence must never break the actual install — so the caller decides whether to swallow
 * errors. Reads the existing tail to find `prevHash`, so concurrent writers could race; for a
 * single-process CLI run that's fine, and a later {@link verifyChain} would surface any damage.
 */
export function appendAudit(file: string, event: string, detail: Record<string, unknown> | undefined, opts: { now: Date }): AuditEntry {
  const existing = readAuditLog(file);
  const entry = chainEntry(existing[existing.length - 1], opts.now.toISOString(), event, detail);
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

export interface ChainVerdict {
  ok: boolean;
  /** Number of entries checked. */
  length: number;
  /** First broken sequence number, if any. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Verify a chain is internally consistent: every entry's `hash` recomputes, and each `prevHash`
 * equals the prior entry's `hash` (the first must be {@link GENESIS}). Any in-place edit, reordered
 * line, or deleted middle entry breaks the recomputation at that point. Returns the first break.
 */
export function verifyChain(entries: AuditEntry[]): ChainVerdict {
  let prev: AuditEntry | undefined;
  for (const e of entries) {
    const expectedPrev = prev ? prev.hash : GENESIS;
    if (e.prevHash !== expectedPrev) return { ok: false, length: entries.length, brokenAt: e.seq, reason: `prevHash mismatch at seq ${e.seq} (chain was reordered or an entry was removed)` };
    const { hash, ...fields } = e;
    if (entryDigest(fields) !== hash) return { ok: false, length: entries.length, brokenAt: e.seq, reason: `hash mismatch at seq ${e.seq} (entry was altered after it was written)` };
    prev = e;
  }
  return { ok: true, length: entries.length };
}

// ───────────────────────────── ed25519-signed receipts ─────────────────────────────

/** A PEM keypair. The PRIVATE key signs (held by CI/the operator); the PUBLIC key verifies (committed/pinned). */
export interface SigningKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Generate an Ed25519 keypair (PEM-encoded). Ed25519 = small keys, fast, no parameter choices to get wrong. */
export function generateSigningKey(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** A signed statement about something — here, a verify-gate result. The public key is embedded so a verifier is self-contained. */
export interface SignedReceipt<T> {
  version: 1;
  alg: 'ed25519';
  /** The signed claim (canonicalised before signing). */
  payload: T;
  /** SPKI PEM of the signing key, so a holder of a TRUSTED fingerprint can confirm who signed. */
  publicKeyPem: string;
  /** base64 Ed25519 signature over `canonicalize(payload)`. */
  signature: string;
}

/** Sign a payload with an Ed25519 private key (PEM). The signature covers the canonical form, so re-ordering keys can't change what was attested. */
export function signPayload<T>(payload: T, privateKeyPem: string): SignedReceipt<T> {
  const key = createPrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  const signature = sign(null, Buffer.from(canonicalize(payload)), key).toString('base64');
  return { version: 1, alg: 'ed25519', payload, publicKeyPem, signature };
}

/**
 * A short, human-comparable fingerprint of a public key: the first 16 hex of sha256 over the raw SPKI
 * DER bytes. Hashes the DER buffer directly (not a `toString` round-trip) so the value matches standard
 * external tooling, e.g. `openssl pkey -pubin -outform der | openssl dgst -sha256`. For pinning.
 */
export function keyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export interface ReceiptVerdict {
  ok: boolean;
  reason?: string;
  /** Fingerprint of the embedded signing key (so a caller can decide whether to trust it). */
  fingerprint: string;
}

/**
 * Verify a receipt's signature against its embedded public key. The signature being valid proves the
 * payload wasn't altered since signing — but NOT that you should trust the signer: anyone can mint a
 * receipt with their own key. Pass `trustedFingerprint` to also require the signer be the key you
 * pinned (the check that makes this a real gate rather than a rubber stamp).
 */
export function verifyReceipt<T>(receipt: SignedReceipt<T>, opts: { trustedFingerprint?: string } = {}): ReceiptVerdict {
  let fingerprint = '';
  try {
    fingerprint = keyFingerprint(receipt.publicKeyPem);
    const key = createPublicKey(receipt.publicKeyPem);
    const sigOk = verify(null, Buffer.from(canonicalize(receipt.payload)), key, Buffer.from(receipt.signature, 'base64'));
    if (!sigOk) return { ok: false, reason: 'signature does not match payload (it was tampered with, or signed by a different key)', fingerprint };
    if (opts.trustedFingerprint && opts.trustedFingerprint !== fingerprint) {
      return { ok: false, reason: `signed by an untrusted key (${fingerprint}; expected ${opts.trustedFingerprint})`, fingerprint };
    }
    return { ok: true, fingerprint };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), fingerprint };
  }
}
