import { readFileSync } from 'node:fs';
import path from 'node:path';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function evaluateManifestPolicy(pkgJson: unknown): string[] {
  const issues: string[] = [];
  if (!isObject(pkgJson)) return ['package.json must be an object'];
  if (pkgJson.packageManager !== 'pnpm@11.5.1') {
    issues.push('package.json packageManager must stay pinned to pnpm@11.5.1');
  }
  if (!isObject(pkgJson.publishConfig) || pkgJson.publishConfig.access !== 'public' || pkgJson.publishConfig.provenance !== true) {
    issues.push('package.json publishConfig must keep public access and provenance enabled');
  }
  return issues;
}

export function verifyManifestPolicy(rootDir: string): string[] {
  return evaluateManifestPolicy(readJson(path.join(rootDir, 'package.json')));
}
