import { describe, expect, it } from 'vitest';
import { createLogger, formatEvent } from '../src/log.js';
import { parseEgressDenials } from '../src/egress.js';

describe('formatEvent', () => {
  it('renders human lines with a level prefix and fields', () => {
    expect(formatEvent('info', 'building image', { tag: 'x:1' }, false)).toBe('sandbox: building image (tag=x:1)');
    expect(formatEvent('warn', 'blocked egress', { hosts: ['a.com', 'b.com'] }, false)).toBe(
      'sandbox: ⚠ blocked egress (hosts=a.com,b.com)',
    );
  });

  it('serializes object fields as JSON, never [object Object]', () => {
    const line = formatEvent('info', 'ports forwarded', { endpoints: [{ container: 3000, host: 3000, url: 'http://localhost:3000' }] }, false);
    expect(line).not.toContain('[object Object]');
    expect(line).toBe('sandbox: ports forwarded (endpoints={"container":3000,"host":3000,"url":"http://localhost:3000"})');
  });

  it('renders NDJSON when json=true', () => {
    expect(JSON.parse(formatEvent('warn', 'blocked', { hosts: ['a'] }, true))).toEqual({
      level: 'warn',
      msg: 'blocked',
      hosts: ['a'],
    });
  });
});

describe('createLogger', () => {
  it('filters below the configured level and writes to the sink', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    log.info('nope');
    log.warn('yep');
    log.error('also');
    expect(lines).toEqual(['sandbox: ⚠ yep', 'sandbox: ✖ also']);
  });
});

describe('parseEgressDenials', () => {
  it('extracts refused hosts and dedupes', () => {
    const logs = [
      'NOTICE    Jun 08 16:42:04 [1]: Proxying refused on filtered domain "exfil.example.com"',
      'CONNECT   ...: Established connection to host "registry.npmjs.org"',
      'NOTICE    ...: Proxying refused on filtered domain "exfil.example.com"',
      'NOTICE    ...: Proxying refused on filtered domain "evil.test"',
    ].join('\n');
    expect(parseEgressDenials(logs)).toEqual(['exfil.example.com', 'evil.test']);
  });

  it('returns empty when nothing was refused', () => {
    expect(parseEgressDenials('CONNECT ...: Established connection to host "registry.npmjs.org"')).toEqual([]);
  });
});
