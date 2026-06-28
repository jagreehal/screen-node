import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runAuditVerify, runKeygen, signVerifyReceipt, verifyConfig } from '../src/verify.js';
import { appendAudit, generateSigningKey, verifyReceipt, type AuditEntry } from '../src/receipt.js';

/** A project dir with a committed config (+ optional personal local override). Returns the dir. */
function project(json: string, local?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-verify-'));
  writeFileSync(path.join(dir, 'sandbox.config.json'), json);
  if (local !== undefined) writeFileSync(path.join(dir, 'sandbox.config.local.json'), local);
  return dir;
}

const configIn = (dir: string) => path.join(dir, 'sandbox.config.json');

describe('verifyConfig', () => {
  // Isolate the user-global layer so a real file can't sway the gate.
  let savedXdg: string | undefined;
  beforeAll(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'sbx-xdg-'));
  });
  afterAll(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it('fails when there is genuinely no committed config (cwd has none)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-verify-empty-'));
    const res = verifyConfig(dir, undefined);
    expect(res.ok).toBe(false);
    expect(res.problems[0]).toMatch(/no committed sandbox\.config\.json/);
  });

  it('default usage (cwd only) resolves cwd/sandbox.config.json and passes when it exists', () => {
    const dir = project('{ "install": { "network": "allowlist" }, "run": { "network": "none" } }');
    const res = verifyConfig(dir); // no explicit configPath — the regression case
    expect(res.ok).toBe(true);
    expect(res.problems).toEqual([]);
  });

  it('default usage still catches a personal local layer loosening the boundary', () => {
    const dir = project('{ "run": { "network": "none" } }', '{ "run": { "network": "on" } }');
    const res = verifyConfig(dir); // cwd only
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /run\.network widened/.test(p))).toBe(true);
  });

  it('passes for a committed config with no personal loosening, and reports the boundary', () => {
    const dir = project('{ "install": { "network": "allowlist" }, "run": { "network": "none" } }');
    const res = verifyConfig(dir, configIn(dir));
    expect(res.ok).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.summary.join('\n')).toMatch(/install network : allowlist/);
  });

  it('fails when a personal local layer loosens the boundary', () => {
    const dir = project('{ "run": { "network": "none" } }', '{ "run": { "network": "on" }, "grants": { "ssh-agent": true } }');
    const res = verifyConfig(dir, configIn(dir));
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /run\.network widened/.test(p))).toBe(true);
    expect(res.problems.some((p) => /ssh-agent/.test(p))).toBe(true);
  });

  it('fails clearly on an invalid committed config', () => {
    const dir = project('{ "rnu": {} }'); // typo'd section
    const res = verifyConfig(dir, configIn(dir));
    expect(res.ok).toBe(false);
    expect(res.problems[0]).toMatch(/invalid config/i);
  });
});

describe('signVerifyReceipt', () => {
  const now = new Date(Date.UTC(2026, 5, 13));

  it('signs a green boundary and records the exact checks it attests', () => {
    const dir = project('{ "install": { "network": "allowlist" }, "run": { "network": "none" } }');
    const { privateKeyPem } = generateSigningKey();
    const receipt = signVerifyReceipt(dir, privateKeyPem, { configPath: configIn(dir), now, checks: ['boundary', 'scan'] });
    expect(receipt).not.toBeNull();
    expect(receipt!.payload.checks).toEqual(['boundary', 'scan']); // scope is explicit, not implied
    expect(verifyReceipt(receipt!).ok).toBe(true);
  });

  it('refuses to sign when the boundary itself does not verify', () => {
    const dir = project('{ "run": { "network": "none" } }', '{ "run": { "network": "on" } }'); // loosened
    const { privateKeyPem } = generateSigningKey();
    expect(signVerifyReceipt(dir, privateKeyPem, { configPath: configIn(dir), now, checks: ['boundary'] })).toBeNull();
  });
});

describe('runKeygen / runAuditVerify (extracted CLI handlers, now unit-testable)', () => {
  it('runKeygen --json prints a usable keypair', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(runKeygen({ json: true })).toBe(0);
      const out = JSON.parse(spy.mock.calls[0]![0] as string) as { fingerprint: string; publicKeyPem: string; privateKeyPem: string };
      expect(out.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      // The printed private key actually signs a verifiable receipt.
      expect(verifyReceipt(signVerifyReceipt(project('{ "run": { "network": "none" } }'), out.privateKeyPem, { now: new Date(), checks: ['boundary'] })!).ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('runAuditVerify returns 0 for an intact chain and 1 once a line is tampered', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-auditcmd-'));
    const log = path.join(dir, 'audit.jsonl');
    appendAudit(log, 'run', { code: 0 }, { now: new Date(Date.UTC(2026, 5, 13, 0, 0, 0)) });
    appendAudit(log, 'egress.denied', { host: 'evil.com' }, { now: new Date(Date.UTC(2026, 5, 13, 0, 0, 1)) });
    expect(runAuditVerify(log, { json: true })).toBe(0);

    const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
    const first = JSON.parse(lines[0]!) as AuditEntry;
    first.detail = { code: 1 };
    writeFileSync(log, `${JSON.stringify(first)}\n${lines[1]}\n`);
    expect(runAuditVerify(log, { json: true })).toBe(1);
  });
});
