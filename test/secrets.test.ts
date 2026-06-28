import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { highEntropyToken, jwtValid, luhnValid, redact, scanSecrets, scanText, SECRET_RULES, shannonEntropy } from '../src/secrets.js';

describe('redact', () => {
  it('never echoes a full secret', () => {
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA…MPLE (20 chars)');
    expect(redact('short')).toBe('sh…');
  });
});

describe('scanText', () => {
  const ruleHit = (text: string): string[] => scanText(text).map((f) => f.ruleId);

  it('flags high-signal provider tokens', () => {
    expect(ruleHit('aws = AKIAIOSFODNN7EXAMPLE')).toContain('aws-access-key');
    expect(ruleHit('token: ghp_' + 'a'.repeat(36))).toContain('github-token');
    expect(ruleHit('OPENAI=sk-' + 'a'.repeat(40))).toContain('openai-key');
    expect(ruleHit('ANTHROPIC=sk-ant-' + 'a'.repeat(40))).toContain('anthropic-key');
    expect(ruleHit('key=AIza' + 'B'.repeat(35))).toContain('google-api-key');
    expect(ruleHit('NPM=npm_' + 'c'.repeat(36))).toContain('npm-token');
    expect(ruleHit('-----BEGIN OPENSSH PRIVATE KEY-----')).toContain('private-key');
    expect(ruleHit('DATABASE_URL=postgres://user:secretpw@db.example.com:5432/app')).toContain('db-url-creds');
  });

  it('reports the right 1-based line number and redacts the match', () => {
    const findings = scanText('clean line\nAKIAIOSFODNN7EXAMPLE');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 2, ruleId: 'aws-access-key' });
    expect(findings[0]!.redacted).not.toContain('IOSFODNN7');
  });

  it('catches more provider shapes (Groq, OpenRouter, Twilio)', () => {
    expect(ruleHit('GROQ=gsk_' + 'a'.repeat(30))).toContain('groq-key');
    expect(ruleHit('OR=sk-or-v1-' + 'b'.repeat(30))).toContain('openrouter-key');
    expect(ruleHit('TWILIO=AC' + 'a'.repeat(32))).toContain('twilio-sid');
  });

  it('falls back to a generic <SERVICE>_KEY=value match for unbranded keys', () => {
    const hits = scanText('CUSTOM_SERVICE_TOKEN = "abcdef0123456789ABCDEF"');
    expect(hits.map((h) => h.ruleId)).toEqual(['generic-credential']);
    expect(hits[0]!.redacted).not.toContain('abcdef0123456789');
  });

  it('suppresses the generic fallback when a specific rule already matched the line', () => {
    // The line has a provider key AND looks like an assignment — only the specific rule should report.
    const hits = scanText('OPENAI_API_KEY=sk-' + 'z'.repeat(40));
    expect(hits.map((h) => h.ruleId)).toEqual(['openai-key']);
  });

  it('does not fire on innocuous text', () => {
    expect(scanText('const x = 1; // just a comment\nimport foo from "bar";')).toEqual([]);
  });

  it('every rule has a global flag so matchAll is safe', () => {
    for (const r of SECRET_RULES) expect(r.regex.flags).toContain('g');
  });

  it('catches the imported provider shapes (GitLab, HuggingFace, Vercel, GCP, Azure, DigitalOcean)', () => {
    expect(ruleHit('GL=glpat-' + 'a'.repeat(20))).toContain('gitlab-token');
    expect(ruleHit('HF=hf_' + 'a'.repeat(34))).toContain('huggingface-token');
    expect(ruleHit('VERCEL=vercel_' + 'a'.repeat(24))).toContain('vercel-token');
    expect(ruleHit('{ "type": "service_account" }')).toContain('gcp-service-account');
    expect(ruleHit('AccountKey=' + 'a'.repeat(86) + '==')).toContain('azure-storage-key');
    expect(ruleHit('DO=dop_v1_' + 'a'.repeat(64))).toContain('digitalocean-token');
  });
});

describe('checksum / decode validators', () => {
  it('luhnValid accepts a Luhn-valid card and rejects a near-miss', () => {
    expect(luhnValid('4111 1111 1111 1111')).toBe(true); // canonical Visa test number
    expect(luhnValid('4111 1111 1111 1112')).toBe(false); // last digit broken
    expect(luhnValid('1234567890123456')).toBe(false);
  });

  it('the credit-card rule only fires on a Luhn-valid number', () => {
    expect(scanText('card: 4111 1111 1111 1111').map((f) => f.ruleId)).toContain('credit-card');
    // A 16-digit run that fails Luhn (e.g. an order id) must NOT be reported.
    expect(scanText('orderId: 1234 5678 9012 3456').map((f) => f.ruleId)).not.toContain('credit-card');
  });

  it('jwtValid confirms a real header and rejects an eyJ-lookalike', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const realJwt = `${header}.${Buffer.from('{"sub":"1"}').toString('base64url')}.sig_aaaaaaaaaa`;
    expect(jwtValid(realJwt)).toBe(true);
    // Three base64-ish segments starting eyJ but NOT a real header → dropped.
    expect(jwtValid('eyJhello.eyJworld.eyJnope')).toBe(false);
    expect(scanText(realJwt).map((f) => f.ruleId)).toContain('jwt');
  });
});

describe('entropy fallback', () => {
  it('shannonEntropy separates prose from random tokens', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('the quick brown fox')).toBeLessThan(4.2);
    expect(shannonEntropy('Kx9mQ2vL8nF4pR7wZ1aT3bY6cD0eH5j')).toBeGreaterThan(4.2);
  });

  it('highEntropyToken excludes hex digests and UUIDs but flags base64-class randomness', () => {
    expect(highEntropyToken('a'.repeat(40))).toBe(false); // not random
    expect(highEntropyToken('da39a3ee5e6b4b0d3255bfef95601890afd80709')).toBe(false); // sha1 hex maxes at 4.0 bits
    expect(highEntropyToken('550e8400-e29b-41d4-a716-446655440000')).toBe(false); // UUID: dashes not in charset
    expect(highEntropyToken('Kx9mQ2vL8nF4pR7wZ1aT3bY6cD0eH5j')).toBe(true);
  });

  it('flags a high-entropy value on a secret-ish key we have no named pattern for', () => {
    const hits = scanText('dbPassword: "Kx9mQ2vL8nF4pR7wZ1aT3bY6cD0eH5j"');
    expect(hits.map((h) => h.ruleId)).toContain('high-entropy-secret');
    expect(hits[0]!.redacted).not.toContain('Kx9mQ2vL8nF4pR');
  });

  it('does NOT flag a high-entropy blob with no secret-ish key (data URIs, SRI hashes)', () => {
    expect(scanText('integrity: "sha512-Kx9mQ2vL8nF4pR7wZ1aT3bY6cD0eH5jABCDEFabcdef"').map((h) => h.ruleId)).not.toContain('high-entropy-secret');
    expect(scanText('const logo = "Kx9mQ2vL8nF4pR7wZ1aT3bY6cD0eH5j";').map((h) => h.ruleId)).not.toContain('high-entropy-secret');
  });
});

describe('scanSecrets (injected fs)', () => {
  it('scans the listed files and prefixes findings with the relative path', () => {
    const files = ['.env', 'src/clean.ts'];
    const contents: Record<string, string> = {
      '/repo/.env': 'OPENAI_API_KEY=sk-' + 'z'.repeat(40),
      '/repo/src/clean.ts': 'export const answer = 42;',
    };
    const findings = scanSecrets('/repo', {
      listFiles: () => files,
      readFile: (abs) => contents[abs] ?? '',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: '.env', ruleId: 'openai-key' });
  });

  it('returns clean for a repo with no secrets', () => {
    const findings = scanSecrets('/repo', { listFiles: () => ['a.ts'], readFile: () => 'const a = 1;' });
    expect(findings).toEqual([]);
  });
});

describe('scanSecrets (real fs, file vs directory root)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sbx-secrets-'));
    writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=sk-' + 'z'.repeat(40) + '\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('scanning the DIRECTORY finds the key', () => {
    const findings = scanSecrets(dir);
    expect(findings.map((f) => f.ruleId)).toContain('openai-key');
  });

  it('scanning a FILE path finds the key too (regression: used to silently report clean)', () => {
    const findings = scanSecrets(join(dir, '.env'));
    expect(findings.map((f) => f.ruleId)).toContain('openai-key');
    expect(findings[0]!.file).toBe('.env');
  });

  it('a missing scan target THROWS instead of silently reporting clean (security footgun)', () => {
    // A typo'd path must never read as "no secrets found" — that would be a false attestation.
    expect(() => scanSecrets(join(dir, 'does-not-exist'))).toThrow(/cannot scan/);
  });
});
