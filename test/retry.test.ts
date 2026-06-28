import { describe, expect, it } from 'vitest';
import { renderSandboxRetry } from '../src/retry.js';

describe('renderSandboxRetry', () => {
  it('renders the exact retry form with the sandbox global before the command', () => {
    expect(renderSandboxRetry('--allow-all-builds', 'add', ['zod'])).toBe('sandbox --allow-all-builds add zod');
  });

  it('falls back to install when no command is present', () => {
    expect(renderSandboxRetry('--full-network', undefined, [])).toBe('sandbox --full-network install');
  });
});
