import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnvFiles, parseEnvFile, parseEnvFileSpec } from '../src/env-files.js';

function envFixture(body: string): { dir: string; name: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-env-'));
  writeFileSync(path.join(dir, '.env'), body);
  return { dir, name: '.env' };
}

describe('parseEnvFileSpec', () => {
  it('treats a bare path as the whole file (no key filter)', () => {
    expect(parseEnvFileSpec('.env')).toEqual({ file: '.env' });
    expect(parseEnvFileSpec('/abs/path/.env')).toEqual({ file: '/abs/path/.env' });
    expect(parseEnvFileSpec('config/staging.env')).toEqual({ file: 'config/staging.env' });
  });

  it('parses a trailing :KEY,KEY suffix into a key allowlist', () => {
    expect(parseEnvFileSpec('.env:FOO')).toEqual({ file: '.env', keys: ['FOO'] });
    expect(parseEnvFileSpec('.env:FOO,BAR')).toEqual({ file: '.env', keys: ['FOO', 'BAR'] });
    expect(parseEnvFileSpec('config/.env:NPM_TOKEN')).toEqual({ file: 'config/.env', keys: ['NPM_TOKEN'] });
  });

  it('leaves a colon that is not a valid key list as part of the path', () => {
    // suffix has a space / invalid char → not a key list → whole thing is the path
    expect(parseEnvFileSpec('weird:name with space')).toEqual({ file: 'weird:name with space' });
    expect(parseEnvFileSpec('a:b:FOO')).toEqual({ file: 'a:b', keys: ['FOO'] }); // only the last colon splits
  });
});

describe('loadEnvFiles key allowlist', () => {
  it('injects every key for a bare path', () => {
    const { dir, name } = envFixture('FOO=1\nBAR=2\nBAZ=3\n');
    expect(loadEnvFiles([name], dir)).toEqual({ FOO: '1', BAR: '2', BAZ: '3' });
  });

  it('injects only the listed keys with a :KEY,KEY suffix', () => {
    const { dir, name } = envFixture('FOO=1\nBAR=2\nBAZ=3\n');
    expect(loadEnvFiles([`${name}:FOO,BAZ`], dir)).toEqual({ FOO: '1', BAZ: '3' });
  });

  it('skips a requested key that is absent (like --env for an unset var)', () => {
    const { dir, name } = envFixture('FOO=1\n');
    expect(loadEnvFiles([`${name}:FOO,MISSING`], dir)).toEqual({ FOO: '1' });
  });

  it('throws when the file does not exist', () => {
    const { dir } = envFixture('FOO=1\n');
    expect(() => loadEnvFiles(['nope.env:FOO'], dir)).toThrow(/env file not found/);
  });
});

describe('parseEnvFile', () => {
  it('handles export prefixes, quotes, and inline comments', () => {
    const parsed = parseEnvFile('export FOO=1\nBAR="a b"\nBAZ=plain # trailing\nQUX=\'literal\'\n');
    expect(parsed).toEqual({ FOO: '1', BAR: 'a b', BAZ: 'plain', QUX: 'literal' });
  });
});
