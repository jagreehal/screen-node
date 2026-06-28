import { buildHostSuffixes } from './hosts.js';

/**
 * Named, opt-in egress bundles. The default allowlist stays minimal (the npm registry); a group is
 * a curated set of hosts a user can deliberately add — for one run (`--allow-build-hosts`), at init
 * (the interactive picker), or via `sandbox allow --group <name>`. Each group is HONEST about what
 * it opens: a bundle is a convenience, never a silent default, and the host suffixes are anchored
 * the same way the proxy matches them (`(^|\.)suffix$`), so `github.com` never matches evil.github.com.evil.
 */
export interface HostGroup {
  /** Stable id used on the CLI (`--group <name>`). */
  name: string;
  /** Short label for the interactive picker. */
  label: string;
  /** One line on what allowing this opens — written for someone deciding whether to widen egress. */
  why: string;
  /** The host suffixes this group adds to `egress.allow`. */
  hosts: string[];
}

/**
 * Cloud/deploy groups are deliberately NARROW: each is the provider's specific control-plane / API
 * host(s), never a provider-wide wildcard. We do NOT ship `*.amazonaws.com` / `*.vercel.app` /
 * `*.r2.cloudflarestorage.com` — object storage is the canonical exfiltration sink, so blanket-
 * allowing it would defeat default-deny. Per-project storage/regional endpoints stay an explicit
 * `sandbox allow <host>` decision. These matter at run/deploy time (`sandbox dev`/`run`), not install.
 */
export const HOST_GROUPS: readonly HostGroup[] = [
  {
    name: 'build-tools',
    label: 'Native build tools',
    why: 'Node headers + the binary/release hosts native modules download at install (node-gyp, Prisma, Playwright, Cypress, Puppeteer, Electron, GitHub releases)',
    hosts: buildHostSuffixes(),
  },
  {
    name: 'vercel',
    label: 'Vercel (API)',
    why: 'the Vercel REST API for the CLI and deploys, api.vercel.com (NOT *.vercel.app)',
    hosts: ['api.vercel.com'],
  },
  {
    name: 'cloudflare',
    label: 'Cloudflare (API)',
    why: 'the Cloudflare API for Wrangler and deploys, api.cloudflare.com (NOT *.r2.cloudflarestorage.com)',
    hosts: ['api.cloudflare.com'],
  },
  {
    name: 'supabase',
    label: 'Supabase (API + project)',
    why: 'the Supabase management API and project endpoints, api.supabase.com, *.supabase.co',
    hosts: ['api.supabase.com', 'supabase.co'],
  },
  {
    name: 'aws',
    label: 'AWS (STS auth only)',
    why: 'AWS STS for credential/assume-role calls, sts.amazonaws.com only. Deliberately excludes *.amazonaws.com (S3 = exfil sink); add specific regional endpoints (e.g. s3.eu-west-1.amazonaws.com) with `screen allow`',
    hosts: ['sts.amazonaws.com'],
  },
];

export function hostGroup(name: string): HostGroup | undefined {
  return HOST_GROUPS.find((g) => g.name === name);
}

export const HOST_GROUP_NAMES: readonly string[] = HOST_GROUPS.map((g) => g.name);
