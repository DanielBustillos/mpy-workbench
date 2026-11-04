import * as vscode from "vscode";

/**
 * Central logger for the extension.
 *
 * Messages go to the "MPY Workbench" output channel instead of the extension
 * host console. Debug messages are only written when the
 * `mpyWorkbench.debugLogging` setting is enabled.
 */
let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("MPY Workbench");
  return channel;
}

function debugEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration("mpyWorkbench").get<boolean>("debugLogging", false);
  } catch {
    return false;
  }
}

function format(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: string, parts: unknown[]): void {
  const time = new Date().toISOString().slice(11, 23);
  getChannel().appendLine(`[${time}] [${level}] ${parts.map(format).join(" ")}`);
}

export const log = {
  debug(...parts: unknown[]): void {
    if (debugEnabled()) write("debug", parts);
  },
  info(...parts: unknown[]): void {
    write("info", parts);
  },
  warn(...parts: unknown[]): void {
    write("warn", parts);
  },
  error(...parts: unknown[]): void {
    write("error", parts);
  },
  show(): void {
    getChannel().show(true);
  },
  dispose(): void {
    channel?.dispose();
    channel = undefined;
  },
};
