import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function normalizeRel(file: string): string {
  return file.split(path.sep).join('/');
}

function resolveImportTarget(fromFile: string, specifier: string): string | undefined {
  const abs = path.resolve(path.dirname(fromFile), specifier);
  const tsAbs = abs.replace(/\.m?js$/u, '.ts');
  const candidates = [abs, `${abs}.ts`, tsAbs, path.join(abs, 'index.ts')];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

function collectTypeScriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(abs, out);
      continue;
    }
    if (entry.isFile() && abs.endsWith('.ts')) out.push(abs);
  }
  return out.sort();
}

export function buildImportGraph(srcDir: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of collectTypeScriptFiles(srcDir)) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const deps = new Set<string>();
    const visit = (node: ts.Node): void => {
      const specifier = readRelativeSpecifier(node);
      if (specifier) {
        const target = resolveImportTarget(file, specifier);
        if (target) deps.add(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    graph.set(file, [...deps].sort());
  }
  return graph;
}

function readRelativeSpecifier(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier) &&
    node.moduleSpecifier.text.startsWith('.')
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1
  ) {
    const arg = node.arguments[0];
    if (arg && ts.isStringLiteralLike(arg) && arg.text.startsWith('.')) {
      return arg.text;
    }
  }
  return undefined;
}

export function findImportCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const stack: string[] = [];
  const active = new Set<string>();
  const seen = new Set<string>();
  const emitted = new Set<string>();

  const visit = (node: string): void => {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const key = cycle.join('>');
      if (!emitted.has(key)) {
        emitted.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    active.add(node);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) visit(dep);
    stack.pop();
    active.delete(node);
  };

  for (const node of graph.keys()) visit(node);
  return cycles;
}

export function detectImportCycles(rootDir: string, relSrcDir = 'src'): string[][] {
  const absSrcDir = path.join(rootDir, relSrcDir);
  const cycles = findImportCycles(buildImportGraph(absSrcDir));
  return cycles.map((cycle) => cycle.map((file) => normalizeRel(path.relative(rootDir, file))));
}
