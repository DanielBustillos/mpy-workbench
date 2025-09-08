"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Esp32DecorationProvider = void 0;
const vscode = require("vscode");
class Esp32DecorationProvider {
    constructor() {
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChange.event;
        this.diffSet = new Set(); // device absolute paths like /code/main.py and dirs
    }
    setDiffs(paths) {
        this.diffSet = new Set(paths);
        this._onDidChange.fire(undefined);
    }
    clear() {
        this.diffSet.clear();
        this._onDidChange.fire(undefined);
    }
    getDiffs() {
        return Array.from(this.diffSet);
    }
    provideFileDecoration(uri) {
        if (uri.scheme !== 'esp32')
            return undefined;
        const p = uri.path; // like /code/main.py
        if (this.diffSet.has(p)) {
            return { badge: 'Δ', tooltip: 'Differs from local', color: new vscode.ThemeColor('charts.red') };
        }
        return undefined;
    }
}
exports.Esp32DecorationProvider = Esp32DecorationProvider;
//# sourceMappingURL=decorations.js.map