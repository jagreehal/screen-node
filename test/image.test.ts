import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '../src/config.js';
import {
  BAKED_COREPACK,
  DEFAULT_BASE_IMAGE,
  bundledImageMaterial,
  corepackPrepareStep,
  customDockerfileWarnings,
  derivedDockerfile,
  extraStepsNeedRepoContext,
  hasExtraLayer,
  isCustomBuild,
  MANAGED_IMAGE,
  MANAGED_IMAGE_REPO,
  resolveBaseImage,
  resolveBuildSpec,
  specFingerprint,
} from '../src/image.js';

/** A fully-defaulted config with an optional `build` override applied. */
function configWith(build: Record<string, unknown> = {}) {
  return SandboxConfigSchema.parse({ build });
}

/** Project root used as the extra-steps build context in these specs. */
const CTX = path.resolve('/project');

describe('resolveBaseImage', () => {
  it('defaults to the bundled base', () => {
    expect(resolveBaseImage(configWith().build)).toBe(DEFAULT_BASE_IMAGE);
  });
  it('derives from nodeVersion', () => {
    expect(resolveBaseImage(configWith({ nodeVersion: '22' }).build)).toBe('node:22-bookworm-slim');
  });
  it('baseImage wins over nodeVersion', () => {
    expect(resolveBaseImage(configWith({ baseImage: 'custom:1', nodeVersion: '22' }).build)).toBe('custom:1');
  });
});

describe('resolveBuildSpec', () => {
  it('a plain config is not a custom build', () => {
    const spec = resolveBuildSpec(configWith(), 'tag:1', CTX);
    expect(spec).toMatchObject({ tag: 'tag:1', baseImage: DEFAULT_BASE_IMAGE, extraPackages: [], extraSteps: [] });
    expect(isCustomBuild(spec)).toBe(false);
    expect(hasExtraLayer(spec)).toBe(false);
  });

  it('a changed base counts as custom but needs no extra layer', () => {
    const spec = resolveBuildSpec(configWith({ nodeVersion: '20' }), 'tag:1', CTX);
    expect(isCustomBuild(spec)).toBe(true);
    expect(hasExtraLayer(spec)).toBe(false);
  });

  it('extra packages/steps require a layer', () => {
    const spec = resolveBuildSpec(configWith({ extraPackages: ['ffmpeg'], extraSteps: ['ENV X=1'] }), 'tag:1', CTX);
    expect(hasExtraLayer(spec)).toBe(true);
    expect(isCustomBuild(spec)).toBe(true);
  });

  it('carries the project root as the extra-steps build context (so COPY/ADD can reach repo files)', () => {
    const spec = resolveBuildSpec(configWith({ extraSteps: ['COPY ./cert.pem /etc/cert.pem'] }), 'tag:1', CTX);
    expect(spec.buildContext).toBe(CTX);
  });

  it('resolves customDockerfileUnsafe to an absolute path', () => {
    const spec = resolveBuildSpec(configWith({ customDockerfileUnsafe: 'docker/My.Dockerfile' }), 'tag:1', CTX);
    expect(spec.customDockerfile).toBe(path.resolve('docker/My.Dockerfile'));
    expect(isCustomBuild(spec)).toBe(true);
  });
});

describe('extraStepsNeedRepoContext', () => {
  it('is true only when a step COPY/ADDs (case-insensitive, leading whitespace ok)', () => {
    expect(extraStepsNeedRepoContext(['COPY ./a /a'])).toBe(true);
    expect(extraStepsNeedRepoContext(['  add ./a /a'])).toBe(true);
    expect(extraStepsNeedRepoContext(['RUN echo hi', 'ENV X=1'])).toBe(false);
    expect(extraStepsNeedRepoContext([])).toBe(false);
  });

  it('does not match COPY/ADD appearing mid-instruction (e.g. inside a RUN)', () => {
    expect(extraStepsNeedRepoContext(['RUN echo "COPY this"'])).toBe(false);
  });
});

describe('derivedDockerfile', () => {
  it('layers extras on top of the already-built base tag', () => {
    const spec = resolveBuildSpec(configWith({ extraPackages: ['ffmpeg', 'imagemagick'], extraSteps: ['ENV FOO=bar'] }), 'tag:1', CTX);
    const out = derivedDockerfile('tag:1-base', spec);
    expect(out.startsWith('FROM tag:1-base\n')).toBe(true);
    expect(out).toContain('ffmpeg imagemagick');
    expect(out).toContain('ENV FOO=bar');
  });
});

describe('specFingerprint', () => {
  const spec = (build: Record<string, unknown>) => resolveBuildSpec(configWith(build), 'tag:1', CTX);

  it('is stable for the same spec and ignores the tag', () => {
    expect(specFingerprint(spec({}))).toBe(specFingerprint(resolveBuildSpec(configWith(), 'other:tag', CTX)));
  });

  it('changes when the base, packages, or steps change', () => {
    const base = specFingerprint(spec({}));
    expect(specFingerprint(spec({ nodeVersion: '20' }))).not.toBe(base);
    expect(specFingerprint(spec({ extraPackages: ['ffmpeg'] }))).not.toBe(base);
    expect(specFingerprint(spec({ extraSteps: ['ENV X=1'] }))).not.toBe(base);
  });

  it('changes when the custom Dockerfile CONTENTS change (not just its path)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-fp-'));
    const file = path.join(dir, 'My.Dockerfile');
    writeFileSync(file, 'FROM node:24\n');
    const before = specFingerprint(spec({ customDockerfileUnsafe: file }));
    writeFileSync(file, 'FROM node:24\nRUN echo changed\n');
    expect(specFingerprint(spec({ customDockerfileUnsafe: file }))).not.toBe(before);
  });
});

describe('bundledImageMaterial', () => {
  it('changes when the bundled Dockerfile recipe changes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-bundled-'));
    const dockerfile = path.join(dir, 'Dockerfile');
    const guard = path.join(dir, 'net-guard.sh');
    writeFileSync(dockerfile, 'FROM node:24\n');
    writeFileSync(guard, '#!/bin/sh\necho guard\n');
    const before = bundledImageMaterial(dir);
    writeFileSync(dockerfile, 'FROM node:24\nRUN echo changed\n');
    expect(bundledImageMaterial(dir)).not.toBe(before);
  });
});

describe('customDockerfileWarnings', () => {
  it('flags every dropped security layer', () => {
    const warnings = customDockerfileWarnings('FROM node:24\nRUN echo hi\n');
    expect(warnings.some((w) => /sbx-net-guard/.test(w))).toBe(true);
    expect(warnings.some((w) => /libcap2-bin/.test(w))).toBe(true);
    expect(warnings.some((w) => /corepack/.test(w))).toBe(true);
  });

  it('stays quiet when the markers are present', () => {
    const content = 'FROM node:24\nRUN apt-get install -y libcap2-bin\nCOPY net-guard.sh /usr/local/bin/sbx-net-guard\nRUN corepack enable\n';
    expect(customDockerfileWarnings(content)).toEqual([]);
  });
});

describe('corepackPrepareStep', () => {
  it('bakes a pinned pnpm/yarn version that differs from the baked default', () => {
    expect(corepackPrepareStep('pnpm@11.5.3')).toBe('RUN ["corepack","prepare","pnpm@11.5.3","--activate"]');
    expect(corepackPrepareStep('yarn@4.5.0')).toBe('RUN ["corepack","prepare","yarn@4.5.0","--activate"]');
  });
  it('passes the integrity hash through to corepack', () => {
    expect(corepackPrepareStep('pnpm@11.5.3+sha512.abc')).toBe('RUN ["corepack","prepare","pnpm@11.5.3+sha512.abc","--activate"]');
  });
  it('skips when the pin already matches the baked version', () => {
    expect(corepackPrepareStep(`pnpm@${BAKED_COREPACK.pnpm}`)).toBeNull();
    expect(corepackPrepareStep(`yarn@${BAKED_COREPACK.yarn}`)).toBeNull();
  });
  it('skips npm, bun, and absent pins', () => {
    expect(corepackPrepareStep('npm@10.0.0')).toBeNull();
    expect(corepackPrepareStep('bun@1.2.0')).toBeNull();
    expect(corepackPrepareStep(undefined)).toBeNull();
  });
});

describe('resolveBuildSpec, package manager baking', () => {
  function projectWith(pkg: Record<string, unknown>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-pm-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
  }

  it('prepends a corepack step for a pinned pnpm version, before user extra steps', () => {
    const dir = projectWith({ packageManager: 'pnpm@11.5.3' });
    const spec = resolveBuildSpec(configWith({ extraSteps: ['RUN echo hi'] }), 'tag', dir);
    expect(spec.extraSteps).toEqual(['RUN ["corepack","prepare","pnpm@11.5.3","--activate"]', 'RUN echo hi']);
    expect(hasExtraLayer(spec)).toBe(true);
  });

  it('adds no step for a project with no packageManager pin', () => {
    const dir = projectWith({ name: 'x' });
    expect(resolveBuildSpec(configWith(), 'tag', dir).extraSteps).toEqual([]);
  });

  it('adds no step when the project package.json is unreadable', () => {
    expect(resolveBuildSpec(configWith(), 'tag', CTX).extraSteps).toEqual([]);
  });
});

describe('per-fingerprint managed image tag', () => {
  it('derives a per-fingerprint tag for the built-in managed image', () => {
    const spec = resolveBuildSpec(configWith(), MANAGED_IMAGE, CTX);
    expect(spec.tag).toMatch(new RegExp(`^${MANAGED_IMAGE_REPO}:[0-9a-f]{16}$`));
  });

  it('honours a custom/explicit image name verbatim', () => {
    expect(resolveBuildSpec(configWith(), 'my-image:1', CTX).tag).toBe('my-image:1');
  });

  it('gives different build configs different tags, so projects do not clobber one shared image', () => {
    const a = resolveBuildSpec(configWith(), MANAGED_IMAGE, CTX).tag;
    const b = resolveBuildSpec(configWith({ nodeVersion: '20' }), MANAGED_IMAGE, CTX).tag;
    expect(a).not.toBe(b);
  });

  it('is deterministic for the same config (stable reuse across runs)', () => {
    expect(resolveBuildSpec(configWith(), MANAGED_IMAGE, CTX).tag).toBe(resolveBuildSpec(configWith(), MANAGED_IMAGE, CTX).tag);
  });
});
