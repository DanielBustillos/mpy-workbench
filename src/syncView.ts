
import * as vscode from "vscode";

export interface SyncActionNode { id: string; label: string; command: string }

export class SyncTree implements vscode.TreeDataProvider<SyncActionNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  refreshTree(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(element: SyncActionNode): vscode.TreeItem {
    return this.getTreeItemForAction(element);
  }

  async getChildren(): Promise<SyncActionNode[]> {
    return this.getActionNodes();
  }

  getTreeItemForAction(element: SyncActionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    if (element.id === "toggleAutoSync") {
      item.command = { command: "mpyWorkbench.toggleWorkspaceAutoSync", title: element.label };
      item.iconPath = new vscode.ThemeIcon("sync");
    } else {
      item.command = { command: "mpyWorkbench.runFromView", title: element.label, arguments: [element.command] };
      if (element.id === "initializeWorkspace") item.iconPath = new vscode.ThemeIcon("folder-opened");
      if (element.id === "baseline") item.iconPath = new vscode.ThemeIcon("cloud-upload");
      if (element.id === "baselineFromBoard") item.iconPath = new vscode.ThemeIcon("cloud-download");
      if (element.id === "deleteAllBoard") item.iconPath = new vscode.ThemeIcon("trash", new vscode.ThemeColor("charts.red"));
    }
    return item;
  }

  async getActionNodes(): Promise<SyncActionNode[]> {
    const fs = require('fs');
    const ws = vscode.workspace.workspaceFolders?.[0];
    const initialized = ws && fs.existsSync(ws.uri.fsPath + '/.mpy-workbench/esp32sync.json');
    const initLabel = initialized ? "De-initialize Workspace" : "Initialize Workspace";

    // Determina el estado actual de autosync para mostrarlo en el label
    let autoSyncLabel = "Autosync: Off";
    try {
      if (ws) {
        const cfg = fs.existsSync(ws.uri.fsPath + '/.mpy-workbench/config.json')
          ? JSON.parse(fs.readFileSync(ws.uri.fsPath + '/.mpy-workbench/config.json', 'utf8'))
          : {};
        const enabled = typeof cfg.autoSyncOnSave === 'boolean'
          ? cfg.autoSyncOnSave
          : vscode.workspace.getConfiguration().get<boolean>('mpyWorkbench.autoSyncOnSave', false);
        autoSyncLabel = enabled ? 'Autosync: On' : 'Autosync: Off';
      }
    } catch {}
    return [
      { id: "initializeWorkspace", label: initLabel, command: "mpyWorkbench.initializeWorkspace" },
      { id: "toggleAutoSync", label: autoSyncLabel, command: "mpyWorkbench.toggleWorkspaceAutoSync" },
      { id: "baseline", label: "Upload all files (Local → Board)", command: "mpyWorkbench.syncBaseline" },
      { id: "baselineFromBoard", label: "Download all files (Board → Local)", command: "mpyWorkbench.syncBaselineFromBoard" },
      { id: "deleteAllBoard", label: "Clear Device Files", command: "mpyWorkbench.deleteAllBoard" }
    ];
  }
}
