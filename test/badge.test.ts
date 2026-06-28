import { describe, expect, it } from 'vitest';
import { parseRepoSlug, renderBadge, staticBadge, workflowBadge } from '../src/badge.js';

describe('parseRepoSlug', () => {
  it('parses ssh, https, and bare git URLs', () => {
    expect(parseRepoSlug('git@github.com:jagreehal/screen-node.git')).toBe('jagreehal/screen-node');
    expect(parseRepoSlug('https://github.com/jagreehal/screen-node.git')).toBe('jagreehal/screen-node');
    expect(parseRepoSlug('https://github.com/jagreehal/screen-node')).toBe('jagreehal/screen-node');
    expect(parseRepoSlug('git+https://github.com/jagreehal/screen-node.git')).toBe('jagreehal/screen-node');
  });

  it('parses npm shorthand and owner/repo', () => {
    expect(parseRepoSlug('github:jagreehal/screen-node')).toBe('jagreehal/screen-node');
    expect(parseRepoSlug('jagreehal/screen-node')).toBe('jagreehal/screen-node');
  });

  it('returns undefined for non-github / unrecognised input', () => {
    expect(parseRepoSlug('https://gitlab.com/x/y')).toBeUndefined();
    expect(parseRepoSlug('not a url')).toBeUndefined();
  });
});

describe('badge rendering', () => {
  it('static badge claims provenance, not safety, and links to the repo', () => {
    const b = staticBadge('me/app');
    expect(b).toContain('deps-screened');
    expect(b).toContain('https://github.com/me/app');
    expect(b).not.toMatch(/\bsafe\b/i);
  });

  it('static badge falls back to the home project when slug is unknown', () => {
    expect(staticBadge(undefined)).toContain('jagreehal/screen-node');
  });

  it('workflow badge points at the CI run for evidence', () => {
    const b = workflowBadge('me/app', 'screen.yml');
    expect(b).toContain('/me/app/actions/workflows/screen.yml/badge.svg');
  });

  it('renderBadge with --workflow but no detectable slug asks for --repo', () => {
    // A throwaway empty dir has no package.json and (likely) no git remote.
    expect(renderBadge('/nonexistent-dir-xyz', { workflow: 'screen.yml' })).toMatch(/--repo/);
  });

  it('renderBadge honours an explicit slug', () => {
    expect(renderBadge('/nonexistent-dir-xyz', { workflow: 'screen.yml', slug: 'me/app' })).toContain('/me/app/actions/');
  });
});
