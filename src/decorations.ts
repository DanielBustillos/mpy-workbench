import * as vscode from "vscode";

export class Esp32DecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private diffSet = new Set<string>(); // device absolute paths like /code/main.py and dirs
  private localOnlySet = new Set<string>(); // device paths for files that exist locally but not on board

  setDiffs(paths: Iterable<string>) {
    this.diffSet = new Set(paths);
    this._onDidChange.fire(undefined);
  }

  setLocalOnly(paths: Iterable<string>) {
    this.localOnlySet = new Set(paths);
    this._onDidChange.fire(undefined);
  }

  clear() {
    this.diffSet.clear();
    this.localOnlySet.clear();
    this._onDidChange.fire(undefined);
  }

  getDiffs(): string[] {
    return Array.from(this.diffSet);
  }

  getLocalOnly(): string[] {
    return Array.from(this.localOnlySet);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== 'esp32') return undefined;
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
