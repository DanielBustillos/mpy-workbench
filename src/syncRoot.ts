import * as path from "node:path";

/**
 * Local folder that mirrors the board's `mpyWorkbench.rootPath`.
 *
 * By default this is the workspace folder itself. With `mpyWorkbench.localRoot`
 * set (e.g. "device"), only that subfolder is synced, so project files such as
 * docs, tests or tooling stay out of the board (issue #7).
 *
 * The `.mpy-workbench` folder (config, manifest, .mpyignore) always stays at the
 * workspace root. .mpyignore patterns are matched against paths relative to the
 * sync root.
 *
 * This module has no dependency on `vscode` so it can be unit-tested with Node.
 */
export function resolveSyncRoot(workspaceRoot: string, localRoot: string | undefined): string {
  const cleaned = (localRoot || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned === ".") return workspaceRoot;
  const resolved = path.resolve(workspaceRoot, ...cleaned.split("/"));
  // Never allow the sync root to escape the workspace (e.g. "../other").
  const relToWs = path.relative(workspaceRoot, resolved);
  if (relToWs.startsWith("..") || path.isAbsolute(relToWs)) {
    throw new Error(`mpyWorkbench.localRoot must be a folder inside the workspace (got "${localRoot}")`);
  }
  return resolved;
}

/**
 * Posix path of `absPath` relative to the sync root, or undefined when the file
 * is outside the sync root (and therefore has no place on the board).
 */
export function syncRelative(syncRoot: string, absPath: string): string | undefined {
  const rel = path.relative(syncRoot, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}
