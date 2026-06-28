import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadConfig, readConfig, setLocalOff } from '../src/config.js';

function withConfig(json: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-cfg-'));
  writeFileSync(path.join(dir, 'screen.config.json'), json);
  return dir;
}

/** Project + sibling local override in a temp dir. Returns the project config path. */
function withLayers(project: string, local?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-layer-'));
  const projectFile = path.join(dir, 'screen.config.json');
  writeFileSync(projectFile, project);
  if (local !== undefined) writeFileSync(path.join(dir, 'screen.config.local.json'), local);
  return projectFile;
}

describe('readConfig', () => {
  it('returns safe defaults when no file exists', () => {
    const c = readConfig(mkdtempSync(path.join(tmpdir(), 'sbx-empty-')));
    expect(c.install.network).toBe('allowlist'); // default-deny egress during install
    expect(c.install.riskHints).toBe('basic');
    expect(c.install.failOnRisk).toBe(false);
    expect(c.run.network).toBe('none');
    expect(c.egress.allow).toEqual(['npmjs.org', 'npmjs.com']);
    expect(c.grants.claude).toBe('none');
    expect(c.grants.envFiles).toEqual([]);
    expect(c.off).toBe(false); // containment on by default
  });

  it('honours an explicit off:true escape hatch (e.g. from a personal local override)', () => {
    expect(readConfig(withConfig('{ "off": true }')).off).toBe(true);
  });

  it('strips //-comment keys', () => {
    const c = readConfig(withConfig('{ "//": "a note", "install": { "network": "allowlist" } }'));
    expect(c.install.network).toBe('allowlist');
  });

  it('supports JSONC inline // and /* */ comments', () => {
    const c = readConfig(
      withConfig(`{
        // line comment
        "install": { "network": "allowlist" }, // trailing comment
        /* block
           comment */
        "run": { "network": "on" }
      }`),
    );
    expect(c.install.network).toBe('allowlist');
    expect(c.run.network).toBe('on');
  });

  it('preserves // inside string values', () => {
    const c = readConfig(withConfig('{ "grants": { "paths": ["~/x//y:ro"], "envFiles": [".env.local"] } }'));
    expect(c.grants.paths).toEqual(['~/x//y:ro']);
    expect(c.grants.envFiles).toEqual(['.env.local']);
  });

  it('rejects unknown keys (typo protection)', () => {
    // cspell:disable-next-line -- "grnats" is an intentional typo of "grants" (typo-protection test)
    expect(() => readConfig(withConfig('{ "grnats": {} }'))).toThrow(/invalid config/i);
  });

  it('rejects an invalid network mode', () => {
    expect(() => readConfig(withConfig('{ "run": { "network": "wide-open" } }'))).toThrow(/invalid config/i);
  });

  it('accepts install risk settings', () => {
    const c = readConfig(withConfig('{ "install": { "riskHints": "off", "failOnRisk": true } }'));
    expect(c.install.riskHints).toBe('off');
    expect(c.install.failOnRisk).toBe(true);
  });

  it('reports invalid JSON clearly', () => {
    expect(() => readConfig(withConfig('{ not json'))).toThrow(/invalid JSON/i);
  });
});

describe('loadConfig layering', () => {
  // Isolate the user-global layer ($XDG_CONFIG_HOME/sandbox-node/config.json) so a real
  // file on the test machine can't leak into these assertions.
  let savedXdg: string | undefined;
  beforeAll(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'sbx-xdg-'));
  });
  afterAll(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it('local overrides project for ergonomic fields (deep merge, sibling sections preserved)', () => {
    const projectFile = withLayers(
      '{ "run": { "network": "on" }, "install": { "minReleaseAgeDays": 3 } }',
      '{ "install": { "minReleaseAgeDays": 7 } }',
    );
    const { config } = loadConfig(path.dirname(projectFile), projectFile);
    expect(config.install.minReleaseAgeDays).toBe(7); // local wins
    expect(config.run.network).toBe('on'); // project preserved (deep merge, not replace)
  });

  it('setLocalOff writes the toggle to the local override, and `on` overrides a committed off:true', () => {
    const projectFile = withLayers('{ "off": true }'); // team config turned it off
    setLocalOff(projectFile, false); // `sandbox on`
    expect(loadConfig(path.dirname(projectFile), projectFile).config.off).toBe(false); // local wins
    setLocalOff(projectFile, true); // `sandbox off`
    expect(loadConfig(path.dirname(projectFile), projectFile).config.off).toBe(true);
  });

  it('setLocalOff preserves other keys already in the local override', () => {
    const projectFile = withLayers('{}', '{ "updateCheck": false }');
    setLocalOff(projectFile, true);
    const written = JSON.parse(readFileSync(path.join(path.dirname(projectFile), 'screen.config.local.json'), 'utf8'));
    expect(written).toEqual({ updateCheck: false, off: true });
  });

  it('warns LOUDLY when a personal layer turns containment off (off:true beyond a committed off:false)', () => {
    const projectFile = withLayers('{ "off": false }', '{ "off": true }');
    const { config, warnings } = loadConfig(path.dirname(projectFile), projectFile);
    expect(config.off).toBe(true); // it still applies — loosen loudly, not blocked
    expect(warnings.some((w) => /containment DISABLED.*off:true.*personal layer/i.test(w))).toBe(true);
  });

  it('does not warn when off:true is committed in the team config (a reviewed decision, not a personal widen)', () => {
    const projectFile = withLayers('{ "off": true }');
    const { warnings } = loadConfig(path.dirname(projectFile), projectFile);
    expect(warnings.some((w) => /containment DISABLED/i.test(w))).toBe(false);
  });

  it('warns when a local layer loosens the network boundary beyond the committed config', () => {
    const projectFile = withLayers('{ "run": { "network": "none" } }', '{ "run": { "network": "on" } }');
    const { config, warnings } = loadConfig(path.dirname(projectFile), projectFile);
    expect(config.run.network).toBe('on'); // it still applies — loosen loudly, not blocked
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/run\.network widened to 'on'.*team config: 'none'/);
  });

  it('warns when a local layer adds egress hosts beyond the committed allowlist', () => {
    const projectFile = withLayers('{}', '{ "egress": { "allow": ["npmjs.org", "evil.test"] } }');
    const { warnings } = loadConfig(path.dirname(projectFile), projectFile);
    expect(warnings.some((w) => /egress\.allow added evil\.test/.test(w))).toBe(true);
  });

  it('warns when a local layer enables a credential grant', () => {
    const projectFile = withLayers('{}', '{ "grants": { "ssh-agent": true, "claude": "home" } }');
    const { warnings } = loadConfig(path.dirname(projectFile), projectFile);
    expect(warnings).toContain('grants.ssh-agent enabled beyond team config');
    expect(warnings.some((w) => /grants\.claude widened to 'home'/.test(w))).toBe(true);
  });

  it('does NOT warn when a local layer only tightens the boundary', () => {
    const projectFile = withLayers('{ "run": { "network": "on" } }', '{ "run": { "network": "none" }, "install": { "frozen": true } }');
    const { config, warnings } = loadConfig(path.dirname(projectFile), projectFile);
    expect(config.run.network).toBe('none');
    expect(config.install.frozen).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('does NOT warn when the team (committed) config itself sets the looser value', () => {
    const projectFile = withLayers('{ "run": { "network": "on" }, "egress": { "allow": ["npmjs.org", "extra.test"] } }');
    const { warnings } = loadConfig(path.dirname(projectFile), projectFile);
    expect(warnings).toEqual([]);
  });

  it('rejects unknown keys on the merged composite (typo protection survives layering)', () => {
    const projectFile = withLayers('{}', '{ "rnu": { "network": "on" } }');
    expect(() => loadConfig(path.dirname(projectFile), projectFile)).toThrow(/invalid config/i);
  });

});
