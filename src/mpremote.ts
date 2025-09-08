import { execFile, ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import * as path from "node:path";

function normalizeConnect(c: string): string {
  if (c.startsWith("serial://")) return c.replace(/^serial:\/\//, "");
  if (c.startsWith("serial:/")) return c.replace(/^serial:\//, "");
  return c;
}

function toolPath(): string {
  const ext = vscode.extensions.getExtension("your-name.esp32-files-explorer");
  if (!ext) throw new Error("Extension not found for tool path");
  return path.join(ext.extensionPath, "scripts", "pyserial_tool.py");
}

let currentChild: ChildProcess | null = null;

function runTool(args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }>{
  return new Promise((resolve, reject) => {
    const child = execFile("python3", [toolPath(), ...args], { cwd: opts.cwd }, (err, stdout, stderr) => {
      if (currentChild === child) currentChild = null;
      if (err) return reject(new Error(stderr || err?.message || "tool error"));
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    currentChild = child;
  });
}

export async function ls(p: string): Promise<string> {
  const cfg = vscode.workspace.getConfiguration();
  const connect = normalizeConnect(cfg.get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const { stdout } = await runTool(["ls", "--port", connect, "--path", p]);
  return String(stdout || "");
}

export async function lsTyped(p: string): Promise<{ name: string; isDir: boolean }[]> {
  const cfg = vscode.workspace.getConfiguration();
  const connect = normalizeConnect(cfg.get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const { stdout } = await runTool(["ls_typed", "--port", connect, "--path", p]);
  try { const arr = JSON.parse(String(stdout||"[]")); if (Array.isArray(arr)) return arr; } catch {}
  return [];
}

export async function listSerialPorts(): Promise<string[]> {
  try {
    const { stdout } = await runTool(["devs"]);
    return String(stdout||"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  } catch { return []; }
}

export async function mkdir(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["mkdir", "--port", connect, "--path", p]);
}

export async function rm(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["rm", "--port", connect, "--path", p]);
}

export async function cpFromDevice(devicePath: string, localPath: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["cp_from", "--port", connect, "--src", devicePath, "--dst", localPath]);
}

export async function cpToDevice(localPath: string, devicePath: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["cp_to", "--port", connect, "--src", localPath, "--dst", devicePath]);
}

export async function uploadReplacing(localPath: string, devicePath: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["upload_replacing", "--port", connect, "--src", localPath, "--dst", devicePath]);
}

export async function rmrf(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["rmrf", "--port", connect, "--path", p]);
}

export async function runFile(localPath: string): Promise<{ stdout: string; stderr: string }>{
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const { stdout } = await runTool(["run_file", "--port", connect, "--src", localPath]);
  return { stdout: String(stdout||""), stderr: "" };
}

export async function reset(): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") return;
  try { await runTool(["reset", "--port", connect]); } catch {}
}

export async function listTreeStats(root: string): Promise<Array<{ path: string; isDir: boolean; size: number; mtime: number }>> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("esp32fs.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const { stdout } = await runTool(["tree_stats", "--port", connect, "--path", root]);
  try { const arr = JSON.parse(String(stdout||"[]")); if (Array.isArray(arr)) return arr; } catch {}
  return [];
}

export function cancelAll(): void {
  try { currentChild?.kill('SIGKILL'); } catch {}
  currentChild = null;
}
