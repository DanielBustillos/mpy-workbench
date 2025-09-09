import * as vscode from "vscode";

export interface SyncActionNode { id: string; label: string; command: string }

export class SyncTree implements vscode.TreeDataProvider<SyncActionNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  refreshTree(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(element: SyncActionNode): vscode.TreeItem {
    return this.getTreeItemForAction(element);
  }

  getChildren(): Thenable<SyncActionNode[]> {
    return Promise.resolve(this.getActionNodes());
  }

  getTreeItemForAction(element: SyncActionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.command = { command: "mpyWorkbench.runFromView", title: element.label, arguments: [element.command] };
    if (element.id === "baseline") item.iconPath = new vscode.ThemeIcon("cloud-upload");
    if (element.id === "baselineFromBoard") item.iconPath = new vscode.ThemeIcon("cloud-download");
    if (element.id === "checkDiffs") item.iconPath = new vscode.ThemeIcon("diff");
    if (element.id === "syncDiffsLocalToBoard") item.iconPath = new vscode.ThemeIcon("cloud-upload");
    if (element.id === "syncDiffsBoardToLocal") item.iconPath = new vscode.ThemeIcon("cloud-download");
    if (element.id === "deleteAllBoard") item.iconPath = new vscode.ThemeIcon("trash", new vscode.ThemeColor("charts.red"));
    return item;
  }

  async getActionNodes(): Promise<SyncActionNode[]> {
    return [
      { id: "baseline", label: "Upload all files (Local → Board)", command: "mpyWorkbench.syncBaseline" },
      { id: "baselineFromBoard", label: "Download all files (Board → Local)", command: "mpyWorkbench.syncBaselineFromBoard" },
  { id: "checkDiffs", label: "Check for differences (local vs board)", command: "mpyWorkbench.checkDiffs" },
      { id: "syncDiffsLocalToBoard", label: "Sync changed Files Local → Board", command: "mpyWorkbench.syncDiffsLocalToBoard" },
      { id: "syncDiffsBoardToLocal", label: "Sync changed Files Board → Local", command: "mpyWorkbench.syncDiffsBoardToLocal" },
      { id: "deleteAllBoard", label: "Delete ALL files on Board", command: "mpyWorkbench.deleteAllBoard" }
    ];
  }
}
