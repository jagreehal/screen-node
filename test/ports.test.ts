import { describe, expect, it } from 'vitest';
import { endpointsFor, hostPortOf, isValidPortSpec, normalizePort, parsePortSpec, resolvePortPublish } from '../src/ports.js';

describe('parsePortSpec / normalizePort', () => {
  it('expands a bare port (string or number) to HOST:CONTAINER', () => {
    expect(parsePortSpec('4321')).toEqual({ host: 4321, container: 4321 });
    expect(parsePortSpec(4321)).toEqual({ host: 4321, container: 4321 });
    expect(normalizePort('4321')).toBe('4321:4321');
    expect(normalizePort(4321)).toBe('4321:4321');
  });

  it('keeps an explicit HOST:CONTAINER map', () => {
    expect(normalizePort('3000:3000')).toBe('3000:3000');
    expect(normalizePort('8080:80')).toBe('8080:80');
    expect(parsePortSpec('8080:80')).toEqual({ host: 8080, container: 80 });
  });

  it('preserves an IP:HOST:CONTAINER bind address', () => {
    expect(parsePortSpec('127.0.0.1:3000:3000')).toEqual({ ip: '127.0.0.1', host: 3000, container: 3000 });
    expect(normalizePort('127.0.0.1:3000:3000')).toBe('127.0.0.1:3000:3000');
  });

  it('rejects malformed specs with a message listing the accepted forms', () => {
    expect(() => normalizePort('abc')).toThrow(/invalid port/);
    expect(() => normalizePort('3000:')).toThrow(/invalid port/);
    expect(() => normalizePort('0')).toThrow(/out of range/);
    expect(() => normalizePort('70000')).toThrow(/out of range/);
    expect(isValidPortSpec('abc')).toBe(false);
    expect(isValidPortSpec('4321')).toBe(true);
    expect(isValidPortSpec(8080)).toBe(true);
  });

  it('reports the host port that a normalised spec publishes on', () => {
    expect(hostPortOf('8080:80')).toBe(8080);
  });
});

describe('endpointsFor', () => {
  it('maps specs to localhost URLs on the real host port', () => {
    expect(endpointsFor(['4321:4321', '8080:80'])).toEqual([
      { container: 4321, host: 4321, url: 'http://localhost:4321' },
      { container: 80, host: 8080, url: 'http://localhost:8080' },
    ]);
  });

  it('uses the bind IP in the URL when one is given', () => {
    expect(endpointsFor(['192.168.1.10:3000:3000'])).toEqual([{ container: 3000, host: 3000, url: 'http://192.168.1.10:3000' }]);
  });
});

describe('resolvePortPublish', () => {
  it('skips busy host ports instead of failing the whole run', async () => {
    const taken = new Set([8080]);
    const isFree = async (port: number) => !taken.has(port);
    const { available, busy, conflicts } = await resolvePortPublish(['3000:3000', '8080:8080', '4321:4321'], isFree);
    expect(available).toEqual(['3000:3000', '4321:4321']);
    expect(busy).toEqual(['8080:8080']);
    expect(conflicts).toEqual([]);
  });

  it('surfaces a duplicate host endpoint as a conflict instead of dropping it silently', async () => {
    const { available, conflicts } = await resolvePortPublish(['3000:3000', '3000:3001'], async () => true);
    expect(available).toEqual(['3000:3000']);
    expect(conflicts).toEqual(['3000:3001']);
  });

  it('treats the same host port on different IPs as distinct publishes', async () => {
    const { available, conflicts } = await resolvePortPublish(['127.0.0.1:3000:3000', '192.168.1.10:3000:3000'], async () => true);
    expect(available).toEqual(['127.0.0.1:3000:3000', '192.168.1.10:3000:3000']);
    expect(conflicts).toEqual([]);
  });

  it('probes the specific bind interface, not just the port number', async () => {
    const seen: Array<[number, string]> = [];
    const isFree = async (port: number, address: string) => {
      seen.push([port, address]);
      return true;
    };
    await resolvePortPublish(['127.0.0.1:3000:3000', '4321:4321'], isFree);
    expect(seen).toEqual([
      [3000, '127.0.0.1'],
      [4321, '0.0.0.0'],
    ]);
  });
});
