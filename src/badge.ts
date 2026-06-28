import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Project this package lives in — the fallback link target for the static badge. */
const HOME_SLUG = 'jagreehal/screen-node';

/** Pull `owner/repo` out of a git URL, an npm `repository` field, or a shorthand. */
export function parseRepoSlug(url: string): string | undefined {
  const github = url.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (github) return github[1];
  if (!url.includes('://') && !url.includes('@')) {
    const short = url.replace(/^github:/i, '').match(/^([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (short) return short[1];
  }
  return undefined;
}

/** Best-effort `owner/repo` for this repo: package.json `repository`, else the git remote. */
export function repoSlug(cwd: string): string | undefined {
  const pkgFile = path.join(cwd, 'package.json');
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { repository?: string | { url?: string } };
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
      const slug = repo && parseRepoSlug(repo);
      if (slug) return slug;
    } catch {
      /* fall through to git */
    }
  }
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return url ? parseRepoSlug(url) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Static provenance badge: "deps screened". Claims the *workflow* runs the screen gates,
 * NOT that the package is "safe" — a security tool must never make an unverifiable safety claim.
 */
export function staticBadge(slug: string | undefined): string {
  const link = `https://github.com/${slug ?? HOME_SLUG}`;
  return `[![deps screened](https://img.shields.io/badge/deps-screened-22c55e?logoColor=white)](${link})`;
}

/**
 * Verified badge: a GitHub Actions status badge for the workflow that runs `screen verify`.
 * Green only when that job passes, so it links to real evidence rather than asserting trust.
 */
export function workflowBadge(slug: string, workflow: string): string {
  const base = `https://github.com/${slug}/actions/workflows/${workflow}`;
  return `[![screened](${base}/badge.svg)](${base})`;
}

export interface BadgeOptions {
  /** GitHub Actions workflow file (e.g. `screen.yml`) — switches to the verified, CI-backed badge. */
  workflow?: string;
  /** Override the detected `owner/repo`. */
  slug?: string;
}

/** Render the markdown badge snippet for `screen badge`. */
export function renderBadge(cwd: string, opts: BadgeOptions = {}): string {
  const slug = opts.slug ?? repoSlug(cwd);
  if (opts.workflow) {
    if (!slug) return 'screen: could not detect owner/repo, pass --repo <owner/repo> to emit a verified badge';
    return workflowBadge(slug, opts.workflow);
  }
  return staticBadge(slug);
}
