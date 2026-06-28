import { describe, expect, it } from 'vitest';
import {
  COMPLETION_SHELLS,
  completionScript,
  GLOBAL_FLAGS,
  PRESET_VALUES,
  RISK_VALUES,
  SCREEN_COMMANDS,
} from '../src/completion.js';

describe('completionScript', () => {
  it('emits a script for every supported shell', () => {
    for (const shell of COMPLETION_SHELLS) {
      expect(completionScript(shell), shell).toContain('screen');
    }
  });

  it('lists every sandbox subcommand so they tab-complete', () => {
    for (const shell of COMPLETION_SHELLS) {
      for (const cmd of SCREEN_COMMANDS) {
        expect(completionScript(shell), `${shell} → ${cmd}`).toContain(cmd);
      }
    }
  });

  it('offers the global flags (in each shell’s syntax)', () => {
    // zsh/bash complete the literal `--flag`; fish registers them as `-l flag`.
    for (const flag of ['--config', '--json', '--dry-run', '--risk']) {
      expect(GLOBAL_FLAGS).toContain(flag);
      expect(completionScript('zsh'), `zsh → ${flag}`).toContain(flag);
      expect(completionScript('bash'), `bash → ${flag}`).toContain(flag);
      expect(completionScript('fish'), `fish → ${flag}`).toContain(`-l ${flag.replace(/^--/, '')}`);
    }
  });

  it('completes enum-valued flags with their allowed values', () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = completionScript(shell);
      for (const preset of PRESET_VALUES) expect(script, `${shell} preset`).toContain(preset);
      for (const risk of RISK_VALUES) expect(script, `${shell} risk`).toContain(risk);
    }
  });

  it('targets both binary names (screen and screen-node)', () => {
    expect(completionScript('zsh')).toContain('screen-node');
    expect(completionScript('bash')).toContain('screen-node');
    expect(completionScript('fish')).toContain('screen-node');
  });

  it('uses the idiomatic entry point for each shell', () => {
    expect(completionScript('zsh')).toContain('#compdef');
    expect(completionScript('bash')).toContain('complete -F');
    expect(completionScript('fish')).toContain('complete -c screen');
  });

  describe('inline mode (sourced from an rc file, not an fpath file)', () => {
    it('drops the zsh #compdef header (only valid as the first line of an fpath file)', () => {
      const inline = completionScript('zsh', { inline: true });
      expect(inline).not.toContain('#compdef');
      // still wires the completer, but guarded so a pre-compinit rc never errors
      expect(inline).toContain('compdef _screen screen screen-node');
      expect(inline).toContain('$+functions[compdef]');
    });

    it('leaves bash and fish unchanged (their syntax is already rc-safe)', () => {
      expect(completionScript('bash', { inline: true })).toBe(completionScript('bash'));
      expect(completionScript('fish', { inline: true })).toBe(completionScript('fish'));
    });
  });
});
