import { describe, expect, it } from 'vitest';
import { formatSafeReceipt, freshSubstitutions, incidentallyPinned, rewriteAddArgs, type Substitution } from '../src/safe-install.js';
import type { RiskHint } from '../src/risk.js';

const freshHint = (pkg: string, version: string, aged?: string): RiskHint => ({
  level: 'warn',
  code: 'recent_version',
  package: pkg,
  version,
  message: `recently published; fresh releases are the supply-chain worm window`,
  detail: { publishedAt: '2026-06-17T00:00:00.000Z', severity: 'light', ...(aged ? { aged: { version: aged, ageMs: 18 * 24 * 60 * 60 * 1000 } } : {}) },
});

describe('freshSubstitutions, mapping preflight hints to add substitutions', () => {
  it('substitutes a freshly-published added package for its aged release', () => {
    const subs = freshSubstitutions([freshHint('zod', '3.99.0', '3.98.0')], ['zod']);
    expect(subs).toEqual([{ name: 'zod', from: '3.99.0', to: '3.98.0', reason: expect.stringContaining('predates') as unknown as string }]);
  });

  it('frames the swap as age, never as a safety guarantee', () => {
    const [sub] = freshSubstitutions([freshHint('zod', '3.99.0', '3.98.0')], ['zod']);
    expect(sub!.reason).toMatch(/predates|battle-tested/);
    expect(sub!.reason).not.toMatch(/known.good|is safe|guaranteed/i); // no overselling by age
  });

  it('ignores a fresh hint with no aged release (nothing older is safe to pick)', () => {
    expect(freshSubstitutions([freshHint('zod', '3.99.0')], ['zod'])).toEqual([]);
  });

  it('only touches packages explicitly being added, never an incidental hint', () => {
    expect(freshSubstitutions([freshHint('left-pad', '2.0.0', '1.9.0')], ['zod'])).toEqual([]);
  });

  it('--allow-recent opts a package back into the fresh version (glob supported)', () => {
    expect(freshSubstitutions([freshHint('@acme/ui', '2.0.0', '1.9.0')], ['@acme/ui'], { allowRecent: ['@acme/*'] })).toEqual([]);
  });
});

describe('rewriteAddArgs, the per-PM argv rewrite + exact pin', () => {
  const sub: Substitution = { name: 'zod', from: '3.99.0', to: '3.98.0', reason: 'x' };

  it('rewrites the package token and appends the pnpm/npm exact flag', () => {
    expect(rewriteAddArgs(['zod'], [sub], 'pnpm', false)).toEqual(['zod@3.98.0', '--save-exact']);
    expect(rewriteAddArgs(['zod'], [sub], 'npm', false)).toEqual(['zod@3.98.0', '--save-exact']);
  });

  it('uses --exact for yarn and bun', () => {
    expect(rewriteAddArgs(['zod'], [sub], 'yarn', false)).toEqual(['zod@3.98.0', '--exact']);
    expect(rewriteAddArgs(['zod'], [sub], 'bun', false)).toEqual(['zod@3.98.0', '--exact']);
  });

  it('replaces an explicitly-typed fresh version and preserves other flags/packages', () => {
    expect(rewriteAddArgs(['-D', 'zod@3.99.0', 'lodash'], [sub], 'pnpm', false)).toEqual(['-D', 'zod@3.98.0', 'lodash', '--save-exact']);
  });

  it('handles scoped packages', () => {
    const scoped: Substitution = { name: '@acme/ui', from: '2.0.0', to: '1.9.0', reason: 'x' };
    expect(rewriteAddArgs(['@acme/ui@2.0.0'], [scoped], 'pnpm', false)).toEqual(['@acme/ui@1.9.0', '--save-exact']);
  });

  it('does not duplicate an exact flag the user already passed', () => {
    expect(rewriteAddArgs(['zod', '-E'], [sub], 'pnpm', false)).toEqual(['zod@3.98.0', '-E']);
  });

  it('rewrites an aliased spec by its real name, preserving the alias (the bug that let fresh through)', () => {
    // freshSubstitutions keys by the real name `bar`; the token is `foo@npm:bar@1.2.3`. Must still rewrite.
    const aliased: Substitution = { name: 'bar', from: '1.2.3', to: '1.2.0', reason: 'x' };
    expect(rewriteAddArgs(['foo@npm:bar@1.2.3'], [aliased], 'pnpm', false)).toEqual(['foo@npm:bar@1.2.0', '--save-exact']);
    expect(rewriteAddArgs(['foo@npm:bar'], [aliased], 'pnpm', false)).toEqual(['foo@npm:bar@1.2.0', '--save-exact']);
  });

  it('rewrites an aliased scoped target', () => {
    const aliased: Substitution = { name: '@scope/bar', from: '2.0.0', to: '1.9.0', reason: 'x' };
    expect(rewriteAddArgs(['ui@npm:@scope/bar@2.0.0'], [aliased], 'pnpm', false)).toEqual(['ui@npm:@scope/bar@1.9.0', '--save-exact']);
  });

  it('pinExact forces the exact flag even with no substitution', () => {
    expect(rewriteAddArgs(['lodash'], [], 'pnpm', true)).toEqual(['lodash', '--save-exact']);
    expect(rewriteAddArgs(['lodash'], [], 'pnpm', false)).toEqual(['lodash']); // default: respect the range convention
  });
});

describe('incidentallyPinned, packages an exact flag pins as a side effect', () => {
  const sub: Substitution = { name: 'zod', from: '3.99.0', to: '3.98.0', reason: 'x' };

  it('lists co-installed packages that are not the substituted one', () => {
    expect(incidentallyPinned(['zod', 'lodash'], [sub])).toEqual(['lodash']);
  });

  it('ignores flags and the substituted package itself', () => {
    expect(incidentallyPinned(['-D', 'zod', 'lodash@^4'], [sub])).toEqual(['lodash']);
  });

  it('is empty when the substituted package is the only one', () => {
    expect(incidentallyPinned(['zod'], [sub])).toEqual([]);
  });
});

describe('formatSafeReceipt', () => {
  it('names the swap, says pinned, gives the override, and uses no em dash', () => {
    const r = formatSafeReceipt([{ name: 'zod', from: '3.99.0', to: '3.98.0', reason: 'predates the worm window' }]);
    expect(r).toContain('safe install changed this add:');
    expect(r).toContain('installed zod@3.98.0 (pinned exact), not 3.99.0');
    expect(r).toContain('--allow-recent zod'); // override names the package
    expect(r).not.toContain('—');
  });

  it('flags co-installed packages that get pinned exact as a side effect', () => {
    const r = formatSafeReceipt([{ name: 'zod', from: '3.99.0', to: '3.98.0', reason: 'x' }], ['lodash']);
    expect(r).toContain('lodash is pinned exact too');
    expect(r).toContain('applies to the whole add');
  });

  it('says nothing about side-effect pinning when there are no co-installed packages', () => {
    expect(formatSafeReceipt([{ name: 'zod', from: '3.99.0', to: '3.98.0', reason: 'x' }])).not.toContain('pinned exact too');
  });
});
