import * as vscode from "vscode";

export class Esp32DecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private diffSet = new Set<string>(); // device absolute paths like /code/main.py and dirs

  setDiffs(paths: Iterable<string>) {
    this.diffSet = new Set(paths);
    this._onDidChange.fire(undefined);
  }

  clear() {
    this.diffSet.clear();
    this._onDidChange.fire(undefined);
  }

  getDiffs(): string[] {
    return Array.from(this.diffSet);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== 'esp32') return undefined;
    const p = uri.path; // like /code/main.py
    if (this.diffSet.has(p)) {
      return { badge: 'Δ', tooltip: 'Differs from local', color: new vscode.ThemeColor('charts.red') };
    }
    return undefined;
  }
}
