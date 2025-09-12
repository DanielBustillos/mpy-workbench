import * as vscode from "vscode";

export interface ControlNode { id: string; label: string; command: string; }

export class ControlTree implements vscode.TreeDataProvider<ControlNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void { this._onDidChangeTreeData.fire(); }

  
  getTreeItem(element: ControlNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "control";
    item.command = { command: element.command, title: element.label };
    // Colored icons for control items
    if (element.id === "stop") {
      item.iconPath = new vscode.ThemeIcon("debug-stop", new vscode.ThemeColor("charts.red"));
    } else if (element.id === "interrupt") {
      item.iconPath = new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("charts.yellow"));
    } else if (element.id === "softreboot") {
      item.iconPath = new vscode.ThemeIcon("refresh", new vscode.ThemeColor("charts.blue"));
    }
    return item;
  }

  async getChildren(): Promise<ControlNode[]> { return []; }
}
