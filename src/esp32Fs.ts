import * as vscode from "vscode";
import { Esp32Node } from "./types";
import * as mp from "./mpremote";
import { listDirPyRaw } from "./pyraw";
import { createIgnoreMatcher } from "./sync";
import { log } from "./logger";

type TreeNode = Esp32Node | "no-port";

export class Esp32Tree implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private rawListOnlyOnce = false;

  refreshTree(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(element: Esp32Node | "no-port"): vscode.TreeItem {
    return this.getTreeItemForNode(element);
  }

  getChildren(element?: Esp32Node): Thenable<(Esp32Node | "no-port")[]> {
    return Promise.resolve(this.getChildNodes(element));
  }

  // When set, the next getChildren call will list directly,
  // skipping any auto-suspend/handshake commands.
  enableRawListForNext(): void { this.rawListOnlyOnce = true; }

  getTreeItemForNode(element: Esp32Node | "no-port"): vscode.TreeItem {
    if (element === "no-port") {
      const item = new vscode.TreeItem("", vscode.TreeItemCollapsibleState.None);
      item.command = {
        command: "mpyWorkbench.pickPort",
        title: "Select Port"
      };
      // Use the welcome-view style for the button
      item.tooltip = "Click to select a serial port";
      item.label = "$(plug) Select Serial Port";
      // Aplicar la clase CSS personalizada
      (item as any).className = 'esp32fs-no-port-item';
      return item;
    }
    const item = new vscode.TreeItem(
      element.name,
      element.kind === "dir" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    if ((element as any).isLocalOnly) {
      item.tooltip = '?';
    }
    item.contextValue = element.kind; // for menus
    item.resourceUri = vscode.Uri.parse(`esp32:${element.path}`);
    item.iconPath = element.kind === "dir"
      ? { light: this.icon("folder.svg"), dark: this.icon("folder.svg") }
      : { light: this.icon("file.svg"), dark: this.icon("file.svg") };
    if (element.kind === "file") item.command = {
      command: "mpyWorkbench.openFile",
      title: "Open",
      arguments: [element]
    };
    return item;
  }

  // --- Incremental node cache and addNode method ---
  private _nodeCache: Map<string, Esp32Node[]> = new Map();

  /**
   * Clear the tree node cache (so listed files disappear).
   */
  clearCache(): void {
    this._nodeCache.clear();
  }

  /**
   * Add a node (file or folder) to the in-memory tree and refresh only its parent.
   * @param path Ruta absoluta en el board (ej: /foo/bar.txt)
   * @param isDir true for a folder, false for a file
   */
  addNode(path: string, isDir: boolean) {
    const parentPath = path.includes("/") ? path.replace(/\/[^\/]+$/, "") || "/" : "/";
    const name = path.split("/").pop()!;
    const node: Esp32Node = { kind: isDir ? "dir" : "file", name, path };
    let siblings = this._nodeCache.get(parentPath);
    if (!siblings) {
      siblings = [];
      this._nodeCache.set(parentPath, siblings);
    }
    // Evita duplicados
    if (!siblings.some(n => n.name === name)) {
      siblings.push(node);
      // Sort: folders first, then files, both alphabetically
      siblings.sort((a, b) => (a.kind === b.kind) ? a.name.localeCompare(b.name) : (a.kind === "dir" ? -1 : 1));
    }
    // Refresh the tree (VS Code calls getChildren again; the cache is used)
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Remove a node from the in-memory tree and refresh the view. */
  removeNode(path: string) {
    const parentPath = path.includes("/") ? path.replace(/\/[^\/]+$/, "") || "/" : "/";
    const name = path.split("/").pop()!;
    const siblings = this._nodeCache.get(parentPath);
    if (siblings) {
      const idx = siblings.findIndex(n => n.name === name);
      if (idx >= 0) siblings.splice(idx, 1);
    }
    // If it was a folder, clear its cache
    this._nodeCache.delete(path);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Mark a folder as empty in the cache (useful after deleting a whole directory). */
  resetDir(path: string) {
    this._nodeCache.set(path, []);
    this._onDidChangeTreeData.fire(undefined);
  }

  // getChildNodes uses the cache when available
  async getChildNodes(element?: Esp32Node): Promise<(Esp32Node | "no-port")[]> {
    const port = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
    if (!port || port === "" || port === "auto") {
      return [];
    }
    const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
    const path = element?.path ?? rootPath;
    // Allows forcing a re-list once (from the Refresh button)
    const forceList = this.rawListOnlyOnce;
    this.rawListOnlyOnce = false;
    // If this path is cached and no re-list is forced, use the cache
    if (!forceList && this._nodeCache.has(path)) {
      return this._nodeCache.get(path)!;
    }
    try {
      let entries: { name: string; isDir: boolean }[] | undefined;
      const usePyRaw = vscode.workspace.getConfiguration().get<boolean>("mpyWorkbench.usePyRawList", false);
      entries = await vscode.commands.executeCommand<{ name: string; isDir: boolean }[]>("mpyWorkbench.autoSuspendLs", path);
      if (!entries) {
        entries = usePyRaw ? await listDirPyRaw(path) : await mp.lsTyped(path);
      }
      
      // Create nodes from board files
      const nodes: Esp32Node[] = entries.map(e => {
        const childPath = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
        return { kind: e.isDir ? "dir" : "file", name: e.name, path: childPath };
      });
      
      // Apply ignore rules (from workspace .mpyignore and .mpy-workbench/.mpyignore)
      try {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws) {
          const matcher = await createIgnoreMatcher(ws.uri.fsPath);
          const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
          const filtered = nodes.filter(n => {
            const isDir = n.kind === 'dir';
            // Convert device path to local-relative path for matching
            const normRoot = rootPath === '/' ? '/' : rootPath.replace(/\/$/, '');
            let rel: string;
            if (normRoot === '/') rel = n.path.replace(/^\//, '');
            else if (n.path.startsWith(normRoot + '/')) rel = n.path.slice(normRoot.length + 1);
            else if (n.path === normRoot) rel = '';
            else rel = n.path.replace(/^\//, '');
            return !matcher(rel, isDir);
          });
          nodes.length = 0;
          nodes.push(...filtered);
        }
      } catch {}
      
      // Add local-only files and directories to the tree view
      try {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws) {
          // Access decorations via global reference
          const decorations = (global as any).esp32Decorations;
          if (decorations) {
            const localOnlyFiles = decorations.getLocalOnly();
            const localOnlyDirectories = decorations.getLocalOnlyDirectories();
            const currentPathPrefix = path === "/" ? "/" : path + "/";

            // Collect direct children that should be added
            const itemsToAdd = new Map<string, { path: string; isDir: boolean }>();

            // Find local-only files that should appear in this directory
            for (const localOnlyPath of localOnlyFiles) {
              if (localOnlyPath.startsWith(currentPathPrefix)) {
                const remainingPath = localOnlyPath.slice(currentPathPrefix.length);
                // Only process direct children (no deeper nested paths)
                if (remainingPath && !remainingPath.includes('/')) {
                  // Check if this item is not already in the board entries
                  const alreadyExists = nodes.some(n => n.name === remainingPath);
                  if (!alreadyExists) {
                    itemsToAdd.set(remainingPath, { path: localOnlyPath, isDir: false });
                  }
                } else if (remainingPath && remainingPath.includes('/')) {
                  // This is a nested path - we need to add the parent directory
                  const parentDir = remainingPath.split('/')[0];
                  const parentPath = currentPathPrefix + parentDir;
                  if (!itemsToAdd.has(parentDir) && !nodes.some(n => n.name === parentDir)) {
                    itemsToAdd.set(parentDir, { path: parentPath, isDir: true });
                  }
                }
              }
            }

            // Find local-only directories that should appear in this directory
            for (const localOnlyDirPath of localOnlyDirectories) {
              if (localOnlyDirPath.startsWith(currentPathPrefix)) {
                const remainingPath = localOnlyDirPath.slice(currentPathPrefix.length);
                // Only process direct children (no deeper nested paths)
                if (remainingPath && !remainingPath.includes('/')) {
                  // Check if this directory is not already in the board entries
                  const alreadyExists = nodes.some(n => n.name === remainingPath);
                  if (!alreadyExists) {
                    itemsToAdd.set(remainingPath, { path: localOnlyDirPath, isDir: true });
                  }
                }
              }
            }

            // Add the collected items to nodes
            for (const [name, item] of itemsToAdd) {
              nodes.push({
                kind: item.isDir ? "dir" : "file",
                name: name,
                path: item.path,
                isLocalOnly: true
              });
            }
          }
        }
      } catch (err) {
        // Silently ignore errors when adding local-only files
        log.debug("Could not add local-only files to tree:", err);
      }
      
      nodes.sort((a,b) => (a.kind === b.kind) ? a.name.localeCompare(b.name) : (a.kind === "dir" ? -1 : 1));
      // Cache this directory for incremental updates
      this._nodeCache.set(path, nodes);
      return nodes;
    } catch (err: any) {
      // Only show error if it's not a "no port selected" issue
      const errorMessage = String(err?.message ?? err).toLowerCase();
      const isPortError = errorMessage.includes("select a specific serial port") || 
                         errorMessage.includes("serial port") ||
                         errorMessage.includes("auto");
      
      if (!isPortError && port && port !== "" && port !== "auto") {
        vscode.window.showErrorMessage(`ESP32 list error at ${path}: ${err?.message ?? String(err)}`);
      }
      return [];
    }
  }

  private icon(file: string) {
    return vscode.Uri.joinPath(this.extUri(), "media", file);
  }
  private extUri() {
    // Use the actual publisher.name from package.json
    return vscode.extensions.getExtension("DanielBucam.mpy-workbench")!.extensionUri;
  }
}
