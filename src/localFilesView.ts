import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface LocalFileNode {
  kind: "file" | "dir";
  name: string;
  /** Relative path from workspace root (posix). */
  relPath: string;
  /** Absolute filesystem path. */
  fsPath: string;
}

/** Default folder names to hide from the local tree (like Explorer). */
const DEFAULT_HIDDEN = new Set([
  ".git",
  ".mpy-workbench",
  "node_modules",
  "__pycache__",
  ".vscode",
  ".idea",
]);

export class LocalFilesTree implements vscode.TreeDataProvider<LocalFileNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<LocalFileNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refreshTree(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: LocalFileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.name,
      element.kind === "dir"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.contextValue = element.kind;
    item.resourceUri = vscode.Uri.file(element.fsPath);
    item.iconPath = element.kind === "dir"
      ? new vscode.ThemeIcon("folder")
      : new vscode.ThemeIcon("file");
    if (element.kind === "file") {
      item.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [item.resourceUri],
      };
    }
    return item;
  }

  async getChildren(element?: LocalFileNode): Promise<LocalFileNode[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return [];

    const basePath = element ? element.fsPath : ws.uri.fsPath;
    const relBase = element ? element.relPath : "";

    try {
      const entries = await fs.readdir(basePath, { withFileTypes: true });
      const nodes: LocalFileNode[] = [];

      for (const e of entries) {
        if (!element && DEFAULT_HIDDEN.has(e.name)) continue;

        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        const abs = path.join(basePath, e.name);
        const kind = e.isDirectory() ? "dir" : "file";
        nodes.push({ kind, name: e.name, relPath: rel, fsPath: abs });
      }

      nodes.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

      return nodes;
    } catch {
      return [];
    }
  }

  getParent(element: LocalFileNode): LocalFileNode | undefined {
    if (!element.relPath) return undefined;
    const parentRel = path.posix.dirname(element.relPath);
    if (parentRel === "." || parentRel === element.relPath) return undefined;

    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return undefined;

    const parentFsPath = path.join(ws.uri.fsPath, ...parentRel.split("/"));
    const name = path.posix.basename(parentRel);
    return { kind: "dir", name, relPath: parentRel, fsPath: parentFsPath };
  }
}
