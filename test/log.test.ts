import { describe, expect, it } from 'vitest';
import { createLogger, formatEvent } from '../src/log.js';

describe('formatEvent', () => {
  it('renders human lines with a level prefix and fields', () => {
    expect(formatEvent('info', 'building image', { tag: 'x:1' }, false)).toBe('screen: building image (tag=x:1)');
    expect(formatEvent('warn', 'blocked egress', { hosts: ['a.com', 'b.com'] }, false)).toBe(
      'screen: ⚠ blocked egress (hosts=a.com,b.com)',
    );
  });

  it('serializes object fields as JSON, never [object Object]', () => {
    const line = formatEvent('info', 'ports forwarded', { endpoints: [{ container: 3000, host: 3000, url: 'http://localhost:3000' }] }, false);
    expect(line).not.toContain('[object Object]');
    expect(line).toBe('screen: ports forwarded (endpoints={"container":3000,"host":3000,"url":"http://localhost:3000"})');
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
    expect(lines).toEqual(['screen: ⚠ yep', 'screen: ✖ also']);
  });
});

