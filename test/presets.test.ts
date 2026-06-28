import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '../src/config.js';
import { PRESET_NAMES, presetConfig } from '../src/presets.js';

describe('presets', () => {
  it.each(PRESET_NAMES)('%s produces a config the schema accepts', (name) => {
    expect(() => SandboxConfigSchema.parse(presetConfig(name))).not.toThrow();
  });

  it('returns independent copies (mutation does not leak)', () => {
    const a = presetConfig('balanced');
    a.grants['ssh-agent'] = true;
    expect(presetConfig('balanced').grants['ssh-agent']).toBe(false);
  });

  it('strict is the most locked-down', () => {
    const s = presetConfig('strict');
    expect(s.install).toEqual({ network: 'allowlist', frozen: true, riskHints: 'thorough', failOnRisk: false, minReleaseAgeDays: 7, minReleaseAgeExclude: [], failOnAdvisory: true, malwareFeeds: [], failOnDeprecated: true, cache: true, canaries: true, failOnSourceWrites: true, safeInstall: true, pinExact: false });
    expect(s.run.network).toBe('none');
    expect(s.grants['ssh-agent']).toBe(false);
  });

  it('release-age gate is on by default for the everyday presets (strict/balanced/agent block, vibe warns)', () => {
    // Aikido-style "minimum release age on by default": strict 7d, balanced/agent a softer 3d.
    expect(presetConfig('strict').install.minReleaseAgeDays).toBe(7);
    expect(presetConfig('balanced').install.minReleaseAgeDays).toBe(3);
    expect(presetConfig('agent').install.minReleaseAgeDays).toBe(3);
    // vibe deliberately leaves the gate OFF (warn-only via recent-version hints) so exploring isn't blocked.
    expect(presetConfig('vibe').install.minReleaseAgeDays).toBe(0);
    expect(presetConfig('trusted').install.minReleaseAgeDays).toBe(0);
  });

  it('only strict blocks known malware by default', () => {
    expect(presetConfig('strict').install.failOnAdvisory).toBe(true);
    for (const name of ['balanced', 'vibe', 'agent', 'trusted'] as const) {
      expect(presetConfig(name).install.failOnAdvisory).toBe(false);
    }
  });

  it('only strict arms the source-write tripwire (the everyday presets keep it advisory)', () => {
    expect(presetConfig('strict').install.failOnSourceWrites).toBe(true);
    for (const name of ['balanced', 'vibe', 'agent', 'trusted'] as const) {
      expect(presetConfig(name).install.failOnSourceWrites).toBe(false);
    }
  });

  it('vibe enables dev servers but keeps host creds out', () => {
    const v = presetConfig('vibe');
    expect(v.run.network).toBe('on');
    expect(v.install.network).toBe('allowlist'); // registry-only install preserved
    expect(v.grants['ssh-agent']).toBe(false);
    expect(v.grants.claude).toBe('none');
  });

  it('agent is vibe plus project-scoped AI config, still no host creds', () => {
    const a = presetConfig('agent');
    expect(a.run.network).toBe('on');
    expect(a.grants.claude).toBe('project');
    expect(a.grants['ssh-agent']).toBe(false);
    expect(a.install.canaries).toBe(true); // unattended installs get the honeytoken tripwire
  });

  it('plants canaries on the high-risk presets, not the relaxed ones', () => {
    expect(presetConfig('strict').install.canaries).toBe(true);
    expect(presetConfig('agent').install.canaries).toBe(true);
    for (const name of ['balanced', 'vibe', 'trusted'] as const) {
      expect(presetConfig(name).install.canaries).toBe(false);
    }
  });

  it('rejects an unknown preset', () => {
    // @ts-expect-error testing the runtime guard
    expect(() => presetConfig('nope')).toThrow(/unknown preset/);
  });
});
