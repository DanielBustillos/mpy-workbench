"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ControlTree = void 0;
const vscode = require("vscode");
class ControlTree {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "control";
        item.command = { command: element.command, title: element.label };
        // Colored icons for control items
        if (element.id === "stop") {
            item.iconPath = new vscode.ThemeIcon("debug-stop", new vscode.ThemeColor("charts.red"));
        }
        else if (element.id === "interrupt") {
            item.iconPath = new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("charts.yellow"));
        }
        else if (element.id === "softreboot") {
            item.iconPath = new vscode.ThemeIcon("refresh", new vscode.ThemeColor("charts.blue"));
        }
        return item;
    }
    async getChildren() { return []; }
}
exports.ControlTree = ControlTree;
//# sourceMappingURL=control.js.map