"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionsTree = void 0;
const vscode = require("vscode");
class ActionsTree {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refreshTree() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) {
        return this.getTreeItemForAction(element);
    }
    getChildren() {
        return Promise.resolve(this.getActionNodes());
    }
    getTreeItemForAction(element) {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "action";
        // Route via a wrapper so clicking in the view won't trigger kill/ctrl-c pre-ops
        item.command = { command: "mpyWorkbench.runFromView", title: element.label, arguments: [element.command, ...(element.args ?? [])] };
        // Icons for actions
        if (element.id === "runActive") {
            item.iconPath = new vscode.ThemeIcon("play", new vscode.ThemeColor("charts.green"));
        }
        else if (element.id === "openRepl") {
            item.iconPath = new vscode.ThemeIcon("terminal");
        }
        else if (element.id === "stop") {
            item.iconPath = new vscode.ThemeIcon("debug-stop", new vscode.ThemeColor("charts.red"));
        }
        else if (element.id === "softReset") {
            item.iconPath = new vscode.ThemeIcon("debug-restart", new vscode.ThemeColor("charts.blue"));
        }
        else if (element.id === "sendCtrlC") {
            item.iconPath = new vscode.ThemeIcon("zap", new vscode.ThemeColor("charts.yellow"));
        }
        else if (element.id === "killUsers") {
            item.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("charts.red"));
        }
        else if (element.id === "cancelOps") {
            item.iconPath = new vscode.ThemeIcon("stop-circle", new vscode.ThemeColor("charts.red"));
        }
        else if (element.id === "deleteAll") {
            item.iconPath = new vscode.ThemeIcon("trash");
        }
        else if (element.id === "syncAll") {
            item.iconPath = new vscode.ThemeIcon("cloud-upload");
        }
        else if (element.id === "syncCurrent") {
            item.iconPath = new vscode.ThemeIcon("repo-push");
        }
        return item;
    }
    async getActionNodes() {
        return [
            { id: "runActive", label: "Run Active File", command: "mpyWorkbench.runActiveFile" },
            { id: "openRepl", label: "Open Repl", command: "mpyWorkbench.openRepl" },
            { id: "stop", label: "Stop", command: "mpyWorkbench.stop" },
            { id: "softReset", label: "Soft Reset", command: "mpyWorkbench.softReset" },
            { id: "sendCtrlC", label: "Interrupt", command: "mpyWorkbench.serialSendCtrlC" }
        ];
    }
}
exports.ActionsTree = ActionsTree;
//# sourceMappingURL=actions.js.map