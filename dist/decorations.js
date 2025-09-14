"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Esp32DecorationProvider = void 0;
const vscode = require("vscode");
class Esp32DecorationProvider {
    constructor() {
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChange.event;
        this.diffSet = new Set(); // device absolute paths like /code/main.py and dirs (changed files)
        this.localOnlySet = new Set(); // device paths for files that exist locally but not on board
        this.boardOnlySet = new Set(); // device paths for files that exist on board but not locally
        this.localOnlyDirectories = new Set(); // device paths for directories that exist locally but not on board
    }
    setDiffs(paths) {
        this.diffSet = new Set(paths);
        this._onDidChange.fire(undefined);
    }
    setLocalOnly(paths) {
        this.localOnlySet = new Set(paths);
        this._onDidChange.fire(undefined);
    }
    setBoardOnly(paths) {
        this.boardOnlySet = new Set(paths);
        this._onDidChange.fire(undefined);
    }
    setLocalOnlyDirectories(paths) {
        this.localOnlyDirectories = new Set(paths);
        this._onDidChange.fire(undefined);
    }
    clear() {
        this.diffSet.clear();
        this.localOnlySet.clear();
        this.boardOnlySet.clear();
        this.localOnlyDirectories.clear();
        this._originalDiffs = undefined;
        this._originalLocalOnly = undefined;
        this._originalBoardOnly = undefined;
        this._onDidChange.fire(undefined);
    }
    getDiffs() {
        return Array.from(this.diffSet);
    }
    getLocalOnly() {
        return Array.from(this.localOnlySet);
    }
    getLocalOnlyDirectories() {
        return Array.from(this.localOnlyDirectories);
    }
    // Get only files (no parent directories) for sync operations
    getDiffsFilesOnly() {
        return Array.from(this._originalDiffs || this.diffSet);
    }
    getLocalOnlyFilesOnly() {
        return Array.from(this._originalLocalOnly || this.localOnlySet);
    }
    getBoardOnly() {
        return Array.from(this.boardOnlySet);
    }
    getBoardOnlyFilesOnly() {
        return Array.from(this._originalBoardOnly || this.boardOnlySet);
    }
    provideFileDecoration(uri) {
        if (uri.scheme !== 'esp32')
            return undefined;
        const p = uri.path; // like /code/main.py
        // Check for local-only directories first (more specific)
        if (this.localOnlyDirectories.has(p)) {
            return { badge: '?', tooltip: 'Local-only folder', color: new vscode.ThemeColor('descriptionForeground') };
        }
        // Check for local-only files
        if (this.localOnlySet.has(p)) {
            return { badge: '?', tooltip: 'Only in local', color: new vscode.ThemeColor('descriptionForeground') };
        }
        if (this.boardOnlySet.has(p)) {
            return { badge: 'Δ', tooltip: 'Only in board', color: new vscode.ThemeColor('charts.red') };
        }
        if (this.diffSet.has(p)) {
            return { badge: 'Δ', tooltip: 'Changed file', color: new vscode.ThemeColor('charts.red') };
        }
        return undefined;
    }
}
exports.Esp32DecorationProvider = Esp32DecorationProvider;
//# sourceMappingURL=decorations.js.map