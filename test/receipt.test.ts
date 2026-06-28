import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendAudit,
  canonicalize,
  chainEntry,
  generateSigningKey,
  GENESIS,
  keyFingerprint,
  readAuditLog,
  signPayload,
  verifyChain,
  verifyReceipt,
  type AuditEntry,
} from '../src/receipt.js';

const at = (s: number) => new Date(Date.UTC(2026, 5, 13, 0, 0, s));

describe('canonicalize', () => {
  it('orders object keys so equal content serialises identically', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe(canonicalize({ a: 1, b: 2 }));
    expect(canonicalize({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it('preserves array order and recurses', () => {
    expect(canonicalize({ x: [{ z: 1, y: 2 }] })).toBe('{"x":[{"y":2,"z":1}]}');
  });
});

describe('hash chain', () => {
  it('links each entry to the previous hash, starting from genesis', () => {
    const e0 = chainEntry(undefined, at(0).toISOString(), 'verify', { ok: true });
    const e1 = chainEntry(e0, at(1).toISOString(), 'install.blocked', { pkg: 'evil' });
    expect(e0.prevHash).toBe(GENESIS);
    expect(e0.seq).toBe(0);
    expect(e1.prevHash).toBe(e0.hash);
    expect(e1.seq).toBe(1);
    expect(verifyChain([e0, e1])).toMatchObject({ ok: true, length: 2 });
  });

  it('detects an in-place edit of a past entry', () => {
    const e0 = chainEntry(undefined, at(0).toISOString(), 'verify', { ok: true });
    const e1 = chainEntry(e0, at(1).toISOString(), 'egress.denied', { host: 'evil.com' });
    const tampered: AuditEntry[] = [{ ...e0, detail: { ok: false } }, e1]; // someone flipped the verdict
    const v = verifyChain(tampered);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(0);
  });

  it('detects a removed middle entry', () => {
    const e0 = chainEntry(undefined, at(0).toISOString(), 'a');
    const e1 = chainEntry(e0, at(1).toISOString(), 'b');
    const e2 = chainEntry(e1, at(2).toISOString(), 'c');
    const v = verifyChain([e0, e2]); // e1 dropped
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(2);
  });

  it('appends to a JSONL log and the persisted chain verifies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-audit-'));
    const log = join(dir, 'audit.jsonl');
    appendAudit(log, 'verify', { ok: true }, { now: at(0) });
    appendAudit(log, 'install.blocked', { pkg: 'evil@1.0.0' }, { now: at(1) });
    const entries = readAuditLog(log);
    expect(entries).toHaveLength(2);
    expect(verifyChain(entries).ok).toBe(true);

    // Tamper with the file on disk → verification fails.
    const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
    const first = JSON.parse(lines[0]!) as AuditEntry;
    first.detail = { ok: false };
    writeFileSync(log, `${JSON.stringify(first)}\n${lines[1]}\n`);
    expect(verifyChain(readAuditLog(log)).ok).toBe(false);
  });
});

describe('ed25519 signed receipts', () => {
  it('round-trips: a signed payload verifies, a tampered one does not', () => {
    const { privateKeyPem } = generateSigningKey();
    const receipt = signPayload({ ok: true, boundary: 'install=allowlist' }, privateKeyPem);
    expect(verifyReceipt(receipt).ok).toBe(true);

    const tampered = { ...receipt, payload: { ok: true, boundary: 'install=on' } };
    expect(verifyReceipt(tampered).ok).toBe(false);
  });

  it('verifies regardless of payload key order (canonical signing)', () => {
    const { privateKeyPem } = generateSigningKey();
    const receipt = signPayload({ a: 1, b: 2 }, privateKeyPem);
    const reordered = { ...receipt, payload: { b: 2, a: 1 } };
    expect(verifyReceipt(reordered).ok).toBe(true);
  });

  it('keyFingerprint is sha256 over the raw SPKI DER bytes (matches external tooling, not a string round-trip)', () => {
    const { publicKeyPem } = generateSigningKey();
    const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    const expected = createHash('sha256').update(der).digest('hex').slice(0, 16);
    expect(keyFingerprint(publicKeyPem)).toBe(expected);
  });

  it('enforces a pinned fingerprint, a valid signature from the wrong key is rejected', () => {
    const trusted = generateSigningKey();
    const attacker = generateSigningKey();
    const trustedFp = keyFingerprint(trusted.publicKeyPem);

    const good = signPayload({ ok: true }, trusted.privateKeyPem);
    expect(verifyReceipt(good, { trustedFingerprint: trustedFp }).ok).toBe(true);

    // Attacker re-signs the same claim with their own key: signature is valid, but the key isn't pinned.
    const forged = signPayload({ ok: true }, attacker.privateKeyPem);
    const v = verifyReceipt(forged, { trustedFingerprint: trustedFp });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/untrusted key/);
  });
});
