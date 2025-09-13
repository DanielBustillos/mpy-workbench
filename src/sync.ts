import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface ManifestEntry { size: number; mtime: number; }
export interface Manifest {
  version: 1;
  syncId: string;
  root: string; // local workspace root
  generatedAt: number;
  files: Record<string, ManifestEntry>; // posix-style relative paths
}

export type IgnoreMatcher = (relPath: string, isDir: boolean) => boolean;

export async function buildManifest(rootDir: string, ignore: IgnoreMatcher | Set<string>): Promise<Manifest> {
  const matcher: IgnoreMatcher = (typeof ignore === 'function')
    ? ignore as IgnoreMatcher
    : ((rel, isDir) => (ignore as Set<string>).has(rel.split('/').pop() || rel));

  const files: Record<string, ManifestEntry> = {};
  async function walk(dir: string, relBase = ""): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = path.posix.join(relBase, e.name);
      const abs = path.join(dir, e.name);
      const isDir = e.isDirectory();
      if (matcher(rel, isDir)) continue;
      if (isDir) {
        await walk(abs, rel);
      } else if (e.isFile()) {
        const st = await fs.stat(abs);
        files[rel] = { size: st.size, mtime: Math.floor(st.mtimeMs) };
      }
    }
  }
  await walk(rootDir);
  return { version: 1, syncId: randomUUID(), root: rootDir, generatedAt: Date.now(), files };
}

export function diffManifests(prev: Manifest, next: Manifest): { changedOrNew: string[]; deleted: string[] } {
  const changedOrNew: string[] = [];
  const deleted: string[] = [];
  for (const [p, e] of Object.entries(next.files)) {
    const pe = prev.files[p];
    if (!pe || pe.size !== e.size || pe.mtime !== e.mtime) changedOrNew.push(p);
  }
  for (const p of Object.keys(prev.files)) {
    if (!(p in next.files)) deleted.push(p);
  }
  return { changedOrNew, deleted };
}

export async function saveManifest(filePath: string, m: Manifest): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(m, null, 2), "utf8");
}

export async function loadManifest(filePath: string): Promise<Manifest | undefined> {
  try { const txt = await fs.readFile(filePath, "utf8"); return JSON.parse(txt) as Manifest; }
  catch { return undefined; }
}

export function cloneManifestWithNewId(m: Manifest, newId: string): Manifest {
  return { ...m, syncId: newId, generatedAt: Date.now() };
}

export function defaultIgnorePatterns(): string[] {
  return [
    ".git/",
    ".vscode/",
    "node_modules/",
    "dist/",
    "out/",
    "build/",
    "__pycache__/",
    ".DS_Store",
  ".mpy-workbench/"
  ];
}

function globToRegExp(pat: string): RegExp {
  // basics: * => [^/]*, ** => .* , ? => [^/]
  let pattern = pat.trim();
  const anchorRoot = pattern.startsWith('/');
  if (anchorRoot) pattern = pattern.slice(1);
  // Escape regex special chars EXCEPT glob tokens (*, ?, /)
  pattern = pattern.replace(/([.+^${}()|\[\]\\])/g, '\\$1');
  // Replace ** first
  pattern = pattern.replace(/\*\*/g, '.*');
  // Then * and ?
  pattern = pattern.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  const trailingSlash = pattern.endsWith('/');
  const core = trailingSlash ? pattern.slice(0, -1) : pattern;
  const prefix = anchorRoot ? '^' : '(^|.*/)';
  const suffix = trailingSlash ? '(?:/.*)?$' : '$';
  return new RegExp(prefix + core + suffix);
}

export async function createIgnoreMatcher(rootDir: string): Promise<IgnoreMatcher> {
  const defaults = defaultIgnorePatterns();
  let extra: string[] = [];
  // Read workbench-local ignore file inside .mpy-workbench
  try {
    const txt = await fs.readFile(path.join(rootDir, '.mpy-workbench', '.mpyignore'), 'utf8');
    extra.push(
      ...txt.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
    );
  } catch {}
  const patterns = [...defaults, ...extra];
  const regs = patterns.map(globToRegExp);
  return (relPath: string, isDir: boolean) => {
    const p = relPath.replace(/\\/g, '/');
    return regs.some(r => r.test(p));
  };
}
