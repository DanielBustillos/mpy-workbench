export async function mvOnDevice(src: string, dst: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  try {
    await runTool(["mv", "--port", connect, "--src", src, "--dst", dst]);
  } catch (error: any) {
    throw new Error(`Rename failed: ${error?.message || error}`);
  }
}
import { execFile, ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import * as path from "node:path";

function normalizeConnect(c: string): string {
  if (c.startsWith("serial://")) return c.replace(/^serial:\/\//, "");
  if (c.startsWith("serial:/")) return c.replace(/^serial:\//, "");
  return c;
}

function toolPath(): string {
  const ext = vscode.extensions.getExtension("DanielBucam.mpy-workbench");
  if (!ext) {
    vscode.window.showWarningMessage("No se encontró la extensión 'mpy-workbench'. Verifica el campo 'publisher' y 'name' en tu package.json.");
    throw new Error("Extension not found for tool path");
  }
  return path.join(ext.extensionPath, "scripts", "pyserial_tool.py");
}

let currentChild: ChildProcess | null = null;

let lastDisconnectNotice = 0;
const DISCONNECT_COOLDOWN_MS = 6000;
let suppressSerialNotices = false;

export function setSerialNoticeSuppressed(s: boolean): void {
  suppressSerialNotices = s;
}

function isDisconnectMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("device disconnected") ||
    m.includes("serial read returned no data") ||
    m.includes("device reports readiness to read") ||
    m.includes("device not configured") ||
    m.includes("serial device not available") ||
    m.includes("no such file or directory") ||
    m.includes("serial port not found")
  );
}

function isBusyMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("resource busy") ||
    m.includes("permission denied") ||
    m.includes("port is already open") ||
    m.includes("busy or permission denied") ||
    m.includes("could not open port") ||
    m.includes("could not open serial port")
  );
}

function maybeNotifySerialStatus(msg: string): void {
  if (suppressSerialNotices) return;
  const busy = isBusyMessage(msg);
  const disc = isDisconnectMessage(msg);
  if (!busy && !disc) return;
  const now = Date.now();
  if (now - lastDisconnectNotice < DISCONNECT_COOLDOWN_MS) return;
  lastDisconnectNotice = now;
  if (busy) {
    vscode.window.showWarningMessage(
      "Puerto serie ocupado o sin permisos. Cierra otros monitores (Arduino, Thonny, miniterm) o revisa permisos."
    );
  } else {
    vscode.window.showWarningMessage(
      "ESP32 desconectado o puerto no disponible. Verifica cable/alimentación y vuelve a seleccionar el puerto."
    );
  }
}

function runTool(args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }>{
  return new Promise((resolve, reject) => {
    const execOnce = (attempt: number) => {
      const child = execFile("python3", [toolPath(), ...args], { cwd: opts.cwd }, (err, stdout, stderr) => {
        if (currentChild === child) currentChild = null;
        if (err) {
          const emsg = String(stderr || err?.message || "");
          // One-shot retry for transient disconnect/busy right after port handoff
          if (attempt === 0 && isDisconnectMessage(emsg)) {
            setTimeout(() => execOnce(1), 300);
            return;
          }
          maybeNotifySerialStatus(emsg);
          return reject(new Error(emsg || "tool error"));
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
      currentChild = child;
    };
    execOnce(0);
  });
}

export async function ls(p: string): Promise<string> {
  const cfg = vscode.workspace.getConfiguration();
  const connect = normalizeConnect(cfg.get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const { stdout } = await runTool(["ls", "--port", connect, "--path", p]);
  return String(stdout || "");
}

export async function lsTyped(p: string): Promise<{ name: string; isDir: boolean }[]> {
  const cfg = vscode.workspace.getConfiguration();
  const connect = normalizeConnect(cfg.get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const { stdout } = await runTool(["ls_typed", "--port", connect, "--path", p]);
  try { const arr = JSON.parse(String(stdout||"[]")); if (Array.isArray(arr)) return arr; } catch {}
  return [];
}

export async function listSerialPorts(): Promise<string[]> {
  try {
    const { stdout } = await runTool(["devs"]);
    const ports = String(stdout||"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if (ports.length === 0) {
      vscode.window.showWarningMessage("No serial ports detected. Verifica que Python y pyserial estén instalados en el entorno usado por la extensión.");
    }
    return ports;
  } catch (err: any) {
    vscode.window.showWarningMessage("Error executing Python script to detect ports: " + (err?.message || err));
    return [];
  }
}

export async function mkdir(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["mkdir", "--port", connect, "--path", p]);
}

export async function cpFromDevice(devicePath: string, localPath: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["cp_from", "--port", connect, "--src", devicePath, "--dst", localPath]);
}

export async function cpToDevice(localPath: string, devicePath: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["cp_to", "--port", connect, "--src", localPath, "--dst", devicePath]);
}

export async function uploadReplacing(localPath: string, devicePath: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["upload_replacing", "--port", connect, "--src", localPath, "--dst", devicePath]);
}

export async function deleteFile(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  // Fast path: delete file or directory in a single call
  await runTool(["delete_any", "--port", connect, "--path", p]);
}

export async function deleteAny(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["delete_any", "--port", connect, "--path", p]);
}

export async function deleteFolderRecursive(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await runTool(["delete_folder_recursive", "--port", connect, "--path", p]);
}

export async function fileExists(p: string): Promise<boolean> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  
  try {
    const result = await runTool(["file_exists", "--port", connect, "--path", p]);
    const output = result.stdout.trim();
    return output === "exists";
  } catch (error: any) {
    // If there are serial connection errors, assume the file does not exist
    // ya que no podemos verificar su estado
    const errorStr = String(error?.message || error).toLowerCase();
    if (errorStr.includes("serialexception") || 
        errorStr.includes("device not configured") || 
        errorStr.includes("no such file or directory")) {
      console.warn(`Serial connection error during file check: ${errorStr}`);
      return false;
    }
    return false;
  }
}

export async function getFileInfo(p: string): Promise<{mode: number, size: number, isDir: boolean, isReadonly: boolean} | null> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  
  try {
    const result = await runTool(["file_info", "--port", connect, "--path", p]);
    const parts = result.stdout.split("|");
    if (parts.length >= 4) {
      return {
        mode: parseInt(parts[0]),
        size: parseInt(parts[1]),
        isDir: parts[2] === "dir",
        isReadonly: parts[3] === "ro"
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

export async function deleteAllInPath(rootPath: string): Promise<{deleted: string[], errors: string[], deleted_count?: number, error_count?: number}> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  try {
    const { stdout } = await runTool(["wipe_path", "--port", connect, "--path", rootPath]);
    const s = String(stdout || "{}").trim();
    let obj: any = {};
    try { obj = JSON.parse(s); } catch { obj = {}; }
    const deletedCount = typeof obj.deleted_count === 'number' ? obj.deleted_count : 0;
    const errorsArr = Array.isArray(obj.errors) ? obj.errors : [];
    return { deleted: new Array(deletedCount).fill("") as string[], errors: errorsArr, deleted_count: deletedCount, error_count: errorsArr.length };
  } catch (error: any) {
    return { deleted: [], errors: [String(error?.message || error)], deleted_count: 0, error_count: 1 };
  }
}

export async function runFile(localPath: string): Promise<{ stdout: string; stderr: string }>{
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const { stdout } = await runTool(["run_file", "--port", connect, "--src", localPath]);
  return { stdout: String(stdout||""), stderr: "" };
}

export async function reset(): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") return;
  try { await runTool(["reset", "--port", connect]); } catch {}
}

export async function listTreeStats(root: string): Promise<Array<{ path: string; isDir: boolean; size: number; mtime: number }>> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const { stdout } = await runTool(["tree_stats", "--port", connect, "--path", root]);
  try { const arr = JSON.parse(String(stdout||"[]")); if (Array.isArray(arr)) return arr; } catch {}
  return [];
}

export function cancelAll(): void {
  try { currentChild?.kill('SIGKILL'); } catch {}
  currentChild = null;
}
