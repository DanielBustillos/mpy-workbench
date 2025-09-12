import * as vscode from "vscode";

export interface ActionNode {
  id: string;
  label: string;
  command: string;
  args?: any[];
}

export class ActionsTree implements vscode.TreeDataProvider<ActionNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refreshTree(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(element: ActionNode): vscode.TreeItem {
    return this.getTreeItemForAction(element);
  }

  getChildren(): Thenable<ActionNode[]> {
    return Promise.resolve(this.getActionNodes());
  }

  getTreeItemForAction(element: ActionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "action";
    // Route via a wrapper so clicking in the view won't trigger kill/ctrl-c pre-ops
    item.command = { command: "mpyWorkbench.runFromView", title: element.label, arguments: [element.command, ...(element.args ?? [])] };
    // Icons for actions
    if (element.id === "runActive") {
      item.iconPath = new vscode.ThemeIcon("play", new vscode.ThemeColor("charts.green"));
    } else if (element.id === "openRepl") {
      item.iconPath = new vscode.ThemeIcon("terminal");
    } else if (element.id === "stop") {
      item.iconPath = new vscode.ThemeIcon("debug-stop", new vscode.ThemeColor("charts.red"));
    } else if (element.id === "softReset") {
      item.iconPath = new vscode.ThemeIcon("debug-restart", new vscode.ThemeColor("charts.blue"));
    } else if (element.id === "sendCtrlC") {
      item.iconPath = new vscode.ThemeIcon("zap", new vscode.ThemeColor("charts.yellow"));
    } else if (element.id === "killUsers") {
      item.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("charts.red"));
    } else if (element.id === "cancelOps") {
      item.iconPath = new vscode.ThemeIcon("stop-circle", new vscode.ThemeColor("charts.red"));
    } else if (element.id === "deleteAll") {
      item.iconPath = new vscode.ThemeIcon("trash");
    } else if (element.id === "syncAll") {
      item.iconPath = new vscode.ThemeIcon("cloud-upload");
    } else if (element.id === "syncCurrent") {
      item.iconPath = new vscode.ThemeIcon("repo-push");
    }
    return item;
  }

  async getActionNodes(): Promise<ActionNode[]> {
    return [
      { id: "runActive", label: "Run Active File", command: "mpyWorkbench.runActiveFile" },
      { id: "openRepl", label: "Open Repl", command: "mpyWorkbench.openRepl" },
      { id: "stop", label: "Stop", command: "mpyWorkbench.stop" },
      { id: "softReset", label: "Soft Reset", command: "mpyWorkbench.softReset" },
      { id: "sendCtrlC", label: "Interrupt", command: "mpyWorkbench.serialSendCtrlC" }
    ];
  }
}
