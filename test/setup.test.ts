import { describe, expect, it } from 'vitest';
import { backendDownGuidance } from '../src/setup.js';

describe('backendDownGuidance', () => {
  it('returns undefined when the backend is installed and its daemon is up (error surfaces unchanged)', () => {
    expect(backendDownGuidance({ installed: true, daemonUp: true }, 'docker')).toBeUndefined();
  });

  it('explains a missing runtime with an install hint, leading with the cause', () => {
    const lines = backendDownGuidance({ installed: false, daemonUp: false }, 'docker')!;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("docker isn't installed");
    expect(lines[1]).toContain('install it:');
    expect(lines[2]).toContain('sandbox doctor');
  });

  it('explains a down daemon with a start hint when the runtime IS installed', () => {
    const lines = backendDownGuidance({ installed: true, daemonUp: false }, 'podman')!;
    expect(lines[0]).toContain("podman daemon isn't running");
    expect(lines[1]).toContain('start it:');
  });
})
