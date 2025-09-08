"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionsTree = void 0;
const vscode = require("vscode");
class ActionsTree {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "action";
        // Route via a wrapper so clicking in the view won't trigger kill/ctrl-c pre-ops
        item.command = { command: "esp32fs.runFromView", title: element.label, arguments: [element.command, ...(element.args ?? [])] };
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
    async getChildren() {
        return [
            { id: "runActive", label: "Run Active File", command: "esp32fs.runActiveFile" },
            { id: "openRepl", label: "Open REPL Terminal", command: "esp32fs.openRepl" },
            { id: "stop", label: "Stop (Ctrl-C, Ctrl-A, Ctrl-D)", command: "esp32fs.stop" },
            { id: "sendCtrlC", label: "Interrupt (Ctrl-C, Ctrl-B)", command: "esp32fs.serialSendCtrlC" },
            { id: "killUsers", label: "Close other port services", command: "esp32fs.killPortUsers" }
        ];
    }
}
exports.ActionsTree = ActionsTree;
//# sourceMappingURL=actions.js.map