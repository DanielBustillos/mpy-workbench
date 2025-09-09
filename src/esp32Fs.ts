import * as vscode from "vscode";
import { Esp32Node } from "./types";
import * as mp from "./mpremote";
import { listDirPyRaw } from "./pyraw";

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
      // Usar el estilo de welcome view para el botón
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

  async getChildNodes(element?: Esp32Node): Promise<(Esp32Node | "no-port")[]> {
    const port = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
    if (!port || port === "" || port === "auto") {
      // No error: just return empty to trigger the view's welcome content with a button
      return [];
    }
    
    const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
    const path = element?.path ?? rootPath;
    try {
      let entries: { name: string; isDir: boolean }[] | undefined;
      const usePyRaw = vscode.workspace.getConfiguration().get<boolean>("mpyWorkbench.usePyRawList", false);
      this.rawListOnlyOnce = false;
      entries = await vscode.commands.executeCommand<{ name: string; isDir: boolean }[]>("mpyWorkbench.autoSuspendLs", path);
      if (!entries) {
        entries = usePyRaw ? await listDirPyRaw(path) : await mp.lsTyped(path);
      }
      
      // Create nodes from board files
      const nodes: Esp32Node[] = entries.map(e => {
        const childPath = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
        return { kind: e.isDir ? "dir" : "file", name: e.name, path: childPath };
      });
      
      // Add local-only files to the tree view
      try {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws) {
          // Access decorations via global reference
          const decorations = (global as any).esp32Decorations;
          if (decorations) {
            const localOnlyFiles = decorations.getLocalOnly();
            const currentPathPrefix = path === "/" ? "/" : path + "/";
            
            // Find local-only files that should appear in this directory
            for (const localOnlyPath of localOnlyFiles) {
              if (localOnlyPath.startsWith(currentPathPrefix)) {
                const remainingPath = localOnlyPath.slice(currentPathPrefix.length);
                // Only add direct children (no deeper nested paths)
                if (remainingPath && !remainingPath.includes('/')) {
                  // Check if this file/dir is not already in the board entries
                  const alreadyExists = nodes.some(n => n.name === remainingPath);
                  if (!alreadyExists) {
                    // For now, assume local-only items are files (we could check the filesystem for more accuracy)
                    nodes.push({ 
                      kind: "file", 
                      name: remainingPath, 
                      path: localOnlyPath,
                      isLocalOnly: true 
                    });
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        // Silently ignore errors when adding local-only files
        console.log("Could not add local-only files to tree:", err);
      }
      
      nodes.sort((a,b) => (a.kind === b.kind) ? a.name.localeCompare(b.name) : (a.kind === "dir" ? -1 : 1));
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
