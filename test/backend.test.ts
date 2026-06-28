import { describe, expect, it } from 'vitest';
import { createBackend } from '../src/backend.js';

describe('createBackend', () => {
  it('defaults to docker and honors podman', () => {
    expect(createBackend().bin).toBe('docker');
    expect(createBackend('docker').bin).toBe('docker');
    expect(createBackend('podman').bin).toBe('podman');
  });
});
