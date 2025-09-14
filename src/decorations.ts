import * as vscode from "vscode";

export class Esp32DecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private diffSet = new Set<string>(); // device absolute paths like /code/main.py and dirs (changed files)
  private localOnlySet = new Set<string>(); // device paths for files that exist locally but not on board
  private boardOnlySet = new Set<string>(); // device paths for files that exist on board but not locally
  private localOnlyDirectories = new Set<string>(); // device paths for directories that exist locally but not on board

  setDiffs(paths: Iterable<string>) {
    this.diffSet = new Set(paths);
    this._onDidChange.fire(undefined);
  }

  setLocalOnly(paths: Iterable<string>) {
    this.localOnlySet = new Set(paths);
    this._onDidChange.fire(undefined);
  }

  setBoardOnly(paths: Iterable<string>) {
    this.boardOnlySet = new Set(paths);
    this._onDidChange.fire(undefined);
  }

  setLocalOnlyDirectories(paths: Iterable<string>) {
    this.localOnlyDirectories = new Set(paths);
    this._onDidChange.fire(undefined);
  }

  clear() {
    this.diffSet.clear();
    this.localOnlySet.clear();
    this.boardOnlySet.clear();
    this.localOnlyDirectories.clear();
    (this as any)._originalDiffs = undefined;
    (this as any)._originalLocalOnly = undefined;
    (this as any)._originalBoardOnly = undefined;
    this._onDidChange.fire(undefined);
  }

  getDiffs(): string[] {
    return Array.from(this.diffSet);
  }

  getLocalOnly(): string[] {
    return Array.from(this.localOnlySet);
  }

  getLocalOnlyDirectories(): string[] {
    return Array.from(this.localOnlyDirectories);
  }

  // Get only files (no parent directories) for sync operations
  getDiffsFilesOnly(): string[] {
    return Array.from((this as any)._originalDiffs || this.diffSet);
  }

  getLocalOnlyFilesOnly(): string[] {
    return Array.from((this as any)._originalLocalOnly || this.localOnlySet);
  }

  getBoardOnly(): string[] {
    return Array.from(this.boardOnlySet);
  }

  getBoardOnlyFilesOnly(): string[] {
    return Array.from((this as any)._originalBoardOnly || this.boardOnlySet);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== 'esp32') return undefined;
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
