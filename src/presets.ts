import { SandboxConfigSchema, type SandboxConfig } from './config.js';
import type { z } from 'zod';

export type PresetName = 'strict' | 'balanced' | 'vibe' | 'agent' | 'trusted';

/**
 * What a preset *changes* from the schema defaults — a deep-partial input to
 * {@link SandboxConfigSchema}, so it's never a hand-mirror that can drift. Add a
 * field to the schema and presets pick up its default for free; a preset only
 * mentions a field when it deliberately overrides that default.
 */
export type PresetConfig = z.input<typeof SandboxConfigSchema>;

export interface Preset {
  name: PresetName;
  label: string;
  hint: string;
  config: PresetConfig;
}

/** Predefined configurations, ordered most→least locked-down. `balanced` is the default. */
export const PRESETS: Record<PresetName, Preset> = {
  strict: {
    name: 'strict',
    label: 'Strict',
    hint: 'frozen install, 7-day release-age gate, thorough risk checks, block known malware, registry-only egress',
    // Defaults are already registry-only + no grants + no run network. Strict pins the
    // reproducible (frozen) install, turns on the release-age gate (refuse versions published
    // <7 days ago — the control the 2026-06-04 incident named most effective), runs the full
    // (thorough) risk-signal set, and blocks any version flagged as malware in OSV.
    // Canaries on: strict installs run registry-only, so the egress proxy is always watching — plant
    // honeytokens so a credential-theft attempt is caught in the act, not just blocked anonymously.
    // failOnSourceWrites on: frozen already gives a read-only tree on npm/yarn/bun; this catches the
    // pnpm-writable-root case, so a strict install that edits your source fails instead of passing quietly.
    config: { install: { frozen: true, minReleaseAgeDays: 7, failOnAdvisory: true, riskHints: 'thorough', canaries: true, failOnSourceWrites: true } },
  },
  balanced: {
    name: 'balanced',
    label: 'Balanced (recommended)',
    hint: 'registry-only egress, writable root, 3-day release-age gate, no run network',
    // Age gate ON by default (block versions published <3 days ago) — this matches the
    // "minimum release age on by default" stance and closes the publish-and-detonate window
    // most worms rely on, while a 3-day floor rarely trips a legitimate install.
    config: { install: { minReleaseAgeDays: 3 } },
  },
  vibe: {
    name: 'vibe',
    label: 'Vibe',
    hint: 'balanced + dev servers reachable; fresh-version WARNINGS (not blocks) so exploration is low-friction',
    // Lets dev servers run. Deliberately leaves the release-age gate OFF (warn-only): the
    // recent-version risk hints still flag fresh releases, but exploring/cloning shouldn't be
    // blocked by a freshness gate. Host creds stay out (default).
    config: { install: { minReleaseAgeDays: 0 }, run: { network: 'on' } },
  },
  agent: {
    name: 'agent',
    label: 'Agent',
    hint: 'vibe + project-scoped AI config (./.claude-sandbox); 3-day release-age gate; host credentials blocked',
    // The AI-install path is higher risk (unattended `npm install`), so unlike vibe it keeps the
    // blocking release-age gate on — and plants canaries, since an unattended agent is exactly who
    // you want a credential-theft tripwire watching. Installs are registry-only, so the proxy sees them.
    config: { install: { minReleaseAgeDays: 3, canaries: true }, run: { network: 'on' }, grants: { claude: 'project' } },
  },
  trusted: {
    name: 'trusted',
    label: 'Trusted',
    hint: 'full network + SSH agent + project Claude config, for repos you trust',
    config: {
      install: { network: 'on' },
      run: { network: 'on' },
      grants: { 'ssh-agent': true, claude: 'project' },
    },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

/**
 * A fresh, fully-resolved config for a preset: the preset's deltas parsed through
 * {@link SandboxConfigSchema} so every default is filled in. Safe to mutate.
 */
export function presetConfig(name: PresetName): SandboxConfig {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`sandbox: unknown preset '${name}' (use: ${PRESET_NAMES.join(' | ')})`);
  return SandboxConfigSchema.parse(preset.config);
}
