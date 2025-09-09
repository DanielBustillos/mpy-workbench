import * as vscode from "vscode";
import { Esp32Node } from "./types";
import * as mp from "./mpremote";
import { listDirPyRaw } from "./pyraw";

type TreeNode = Esp32Node | "no-port";

export class Esp32Tree implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private rawListOnlyOnce = false;

  refresh(): void { this._onDidChangeTreeData.fire(); }

  // When set, the next getChildren call will list directly,
  // skipping any auto-suspend/handshake commands.
  setRawListOnlyOnce(): void { this.rawListOnlyOnce = true; }

  getTreeItem(element: Esp32Node | "no-port"): vscode.TreeItem {
    if (element === "no-port") {
      const item = new vscode.TreeItem("", vscode.TreeItemCollapsibleState.None);
      item.description = "";
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

  async getChildren(element?: Esp32Node): Promise<(Esp32Node | "no-port")[]> {
    const port = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
    if (!port || port === "" || port === "auto") {
      // Return empty to trigger the view's welcome content with a button
      return [];
    }
    
    const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
    const path = element?.path ?? rootPath;
    try {
      let entries: { name: string; isDir: boolean }[] | undefined;
      const usePyRaw = vscode.workspace.getConfiguration().get<boolean>("mpyWorkbench.usePyRawList", false);
      // Siempre listar pasando por autoSuspend para evitar conflictos con la terminal REPL
      // Incluso si 'rawListOnlyOnce' estaba activo, no saltamos el auto-suspend para evitar que se "filtre" en miniterm
      this.rawListOnlyOnce = false;
      entries = await vscode.commands.executeCommand<{ name: string; isDir: boolean }[]>("mpyWorkbench.autoSuspendLs", path);
      if (!entries) {
        // Fallback defensivo, igualmente con auto-suspend implícito vía comando ya usado
        entries = usePyRaw ? await listDirPyRaw(path) : await mp.lsTyped(path);
      }
      const nodes: Esp32Node[] = entries.map(e => {
        const childPath = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
        return { kind: e.isDir ? "dir" : "file", name: e.name, path: childPath };
      });
      nodes.sort((a,b) => (a.kind === b.kind) ? a.name.localeCompare(b.name) : (a.kind === "dir" ? -1 : 1));
      return nodes;
    } catch (err: any) {
      vscode.window.showErrorMessage(`ESP32 list error at ${path}: ${err?.message ?? String(err)}`);
      return [];
    }
  }

  private icon(file: string) {
    return vscode.Uri.joinPath(this.extUri(), "media", file);
  }
  private extUri() {
    return vscode.extensions.getExtension("your-name.mpy-workbench")!.extensionUri;
  }
}
