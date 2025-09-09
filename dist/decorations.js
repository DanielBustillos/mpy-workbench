"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Esp32DecorationProvider = void 0;
const vscode = require("vscode");
class Esp32DecorationProvider {
    constructor() {
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChange.event;
        this.diffSet = new Set(); // device absolute paths like /code/main.py and dirs
        this.localOnlySet = new Set(); // device paths for files that exist locally but not on board
    }
    setDiffs(paths) {
        this.diffSet = new Set(paths);
        this._onDidChange.fire(undefined);
    }
    setLocalOnly(paths) {
        this.localOnlySet = new Set(paths);
        this._onDidChange.fire(undefined);
    }
    clear() {
        this.diffSet.clear();
        this.localOnlySet.clear();
        this._originalDiffs = undefined;
        this._originalLocalOnly = undefined;
        this._onDidChange.fire(undefined);
    }
    getDiffs() {
        return Array.from(this.diffSet);
    }
    getLocalOnly() {
        return Array.from(this.localOnlySet);
    }
    // Get only files (no parent directories) for sync operations
    getDiffsFilesOnly() {
        return Array.from(this._originalDiffs || this.diffSet);
    }
    getLocalOnlyFilesOnly() {
        return Array.from(this._originalLocalOnly || this.localOnlySet);
    }
    provideFileDecoration(uri) {
        if (uri.scheme !== 'esp32')
            return undefined;
        const p = uri.path; // like /code/main.py
        if (this.localOnlySet.has(p)) {
            return { badge: '?', tooltip: 'Exists locally but not on board', color: new vscode.ThemeColor('descriptionForeground') };
        }
        if (this.diffSet.has(p)) {
            return { badge: 'Δ', tooltip: 'Differs from local', color: new vscode.ThemeColor('charts.red') };
        }
        return undefined;
    }
}
exports.Esp32DecorationProvider = Esp32DecorationProvider;
//# sourceMappingURL=decorations.js.map