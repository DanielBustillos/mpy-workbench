import * as vscode from "vscode";
import { execFile } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as mp from "./mpremote";
import { getMpremoteExecOptions } from "./mpremote";
import { getPythonPath } from "./pythonInterpreter";
import { buildCommandLine, detectShellKind } from "./shellQuote";
import { log } from "./logger";
import { resolveSyncRoot, syncRelative } from "./syncRoot";

/** Configured serial port without the optional `serial://` prefix, or undefined for "auto". */
function getConfiguredDevice(): string | undefined {
  const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
  if (!connect || connect === "auto") return undefined;
  return connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
}

/** Command line for `python -m mpremote <args>`, quoted for the shell used by new terminals. */
async function buildMpremoteTerminalCommand(args: string[]): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  const pythonPath = await getPythonPath(ws);
  const kind = detectShellKind(vscode.env.shell);
  return buildCommandLine(pythonPath, ["-m", "mpremote", ...args], kind);
}

/**
 * Write raw bytes (e.g. Ctrl-C / Ctrl-D) straight to a serial device.
 * Replaces the old `echo -e ... > port` shell command, which allowed command
 * injection through the port name and did not work on Windows or with dash.
 * Only character devices are accepted, so a bad setting cannot overwrite a file.
 */
async function writeRawToSerialPort(port: string, data: Buffer): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("Direct serial write is not supported on Windows");
  }
  const st = await fs.stat(port);
  if (!st.isCharacterDevice()) {
    throw new Error(`${port} is not a serial device`);
  }
  // O_NONBLOCK: do not hang waiting for carrier detect on macOS /dev/tty.* devices.
  const fh = await fs.open(port, fsConstants.O_WRONLY | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
  try {
    await fh.write(data);
  } finally {
    await fh.close();
  }
}

/** Converts a local relative path (e.g. "sub/test1.py") to a Python import name (e.g. "sub.test1"). */
function localRelToImportName(rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  const withoutPy = normalized.replace(/\.py$/i, "");
  return withoutPy.replace(/\//g, ".");
}

// Disconnect the ESP32 REPL terminal but leave it open
export async function disconnectReplTerminal() {
  if (replTerminal) {
    try {
      // For mpremote, send Ctrl-X to exit cleanly
      replTerminal.sendText("\x18", false); // Ctrl-X
      await new Promise(r => setTimeout(r, 200));
    } catch {}
  }
}

export async function restartReplInExistingTerminal() {
  if (!replTerminal) return;
  try {
    // After Ctrl-X the mpremote process (the terminal's only process) has exited,
    // so text sent to the old terminal goes nowhere. Replace it with a fresh one.
    try { replTerminal.dispose(); } catch {}
    replTerminal = undefined;
    const term = await getReplTerminal();
    term.show(true);
  } catch (err) {
    log.warn("restartReplInExistingTerminal failed:", err);
  }
}

const MPREMOTE_MIN_VERSION = [1, 26, 0] as const;

function parseMpremoteVersion(output: string): [number, number, number] | null {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function isVersionAtLeast(parsed: [number, number, number], min: readonly [number, number, number]): boolean {
  if (parsed[0] !== min[0]) return parsed[0] > min[0];
  if (parsed[1] !== min[1]) return parsed[1] > min[1];
  return parsed[2] >= min[2];
}

async function openReadmeForUpdate(): Promise<void> {
  const uris = await vscode.workspace.findFiles('README.md', null, 1);
  if (uris.length > 0) {
    const doc = await vscode.workspace.openTextDocument(uris[0]);
    await vscode.window.showTextDocument(doc, { preview: false });
  } else {
    await vscode.env.openExternal(vscode.Uri.parse('https://github.com/DanielBustillos/mpy-workbench#readme'));
  }
}

export async function checkMpremoteAvailability(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    getPythonPath(ws).then((pythonPath) => {
      const opts = getMpremoteExecOptions();
      execFile(pythonPath, ["-m", "mpremote", "--version"], opts, (err: any, stdout: string, stderr: string) => {
        if (err) {
          vscode.window.showWarningMessage('mpremote was not found in the active Python interpreter. Install it with: python -m pip install mpremote');
          reject(err);
          return;
        }
        const output = String(stdout || '').trim() + String(stderr || '').trim();
        const parsed = parseMpremoteVersion(output);
        if (parsed && !isVersionAtLeast(parsed, MPREMOTE_MIN_VERSION)) {
          const versionStr = parsed.join('.');
          vscode.window.showWarningMessage(
            `mpremote ${versionStr} detected. This extension requires mpremote >= 1.26 for Upload/Download/Check for differences.`,
            'How to update'
          ).then((choice) => {
            if (choice === 'How to update') {
              openReadmeForUpdate();
            }
          });
        }
        resolve();
      });
    }).catch((err) => {
      if (err) {
        vscode.window.showWarningMessage('Could not resolve the active Python interpreter to check mpremote.');
        reject(err);
      }
    });
  });
}

export async function serialSendCtrlC(): Promise<void> {
  // Use robust interrupt method
  try {
    await robustInterrupt();
  } catch (error: any) {
    // The robust function already handles errors and shows messages
    log.error(`serialSendCtrlC: robustInterrupt failed: ${error}`);
  }
}

export async function stop(): Promise<void> {
  // Use the robust interrupt and reset function
  try {
    await robustInterruptAndReset();
  } catch (error: any) {
    // The robust function already handles errors and shows messages
    log.error(`stop: robustInterruptAndReset failed: ${error}`);
  }
}

export async function softReset(): Promise<void> {
  // If REPL terminal is open, prefer sending through it to avoid port conflicts
  if (isReplOpen()) {
    try {
      const term = await getReplTerminal();
      term.sendText("\x03", false); // Ctrl-C
      await new Promise(r => setTimeout(r, 60));
      term.sendText("\x02", false); // Ctrl-B (friendly REPL)
      await new Promise(r => setTimeout(r, 80));
      term.sendText("\x04", false); // Ctrl-D (soft reset)
      vscode.window.showInformationMessage("Board: Soft reset sent via ESP32 REPL");
      return;
    } catch {
      // fall back to mpremote below
    }
  }

  // Use mpremote connect with explicit port
  const device = getConfiguredDevice() ?? "auto";
  const pythonPath = await getPythonPath(vscode.workspace.workspaceFolders?.[0]);
  const opts = getMpremoteExecOptions();
  await new Promise<void>((resolve) => {
    execFile(pythonPath, ["-m", "mpremote", "connect", device, "reset"], opts, (error: any, stdout: any, stderr: any) => {
      if (error) {
        vscode.window.showErrorMessage(`Board: Soft reset failed: ${stderr || error.message}`);
      } else {
        vscode.window.showInformationMessage(`Board: Soft reset sent via mpremote (${device})`);
      }
      resolve();
    });
  });
}

export async function runActiveFile(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showErrorMessage("No active editor"); return; }
  await ed.document.save();

  const device = getConfiguredDevice();
  if (!device) {
    vscode.window.showErrorMessage("Select a specific serial port first (not 'auto').");
    return;
  }

  const filePath = ed.document.uri.fsPath;

  // If the REPL terminal is open, close it before executing
  if (isReplOpen()) {
    await closeReplTerminal();
    // Wait for the system to release the port
    await new Promise(r => setTimeout(r, 400));
  }

  let cmd: string;
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    cmd = await buildMpremoteTerminalCommand(["connect", device, "run", filePath]);
  } else {
    const rel = syncRelative(getSyncRoot(ws), filePath);
    if (!rel) {
      cmd = await buildMpremoteTerminalCommand(["connect", device, "run", filePath]);
    } else {
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const devicePath = toDevicePath(rel, rootPath);
      let onBoard = false;
      try {
        onBoard = await mp.fileExists(devicePath);
      } catch {
        // Connection or serial error: fall back to run
      }
      if (onBoard) {
        const moduleName = localRelToImportName(rel);
        if (moduleName.includes("..")) {
          cmd = await buildMpremoteTerminalCommand(["connect", device, "run", filePath]);
        } else {
          cmd = await buildMpremoteTerminalCommand(["connect", device, "exec", `import ${moduleName}`]);
        }
      } else {
        cmd = await buildMpremoteTerminalCommand(["connect", device, "run", filePath]);
      }
    }
  }

  if (runFileTerminal) {
    const alive = vscode.window.terminals.some(t => t === runFileTerminal);
    if (!alive) runFileTerminal = undefined;
  }
  if (!runFileTerminal) {
    runFileTerminal = vscode.window.createTerminal({
      name: "ESP32 Run File",
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    });
  }
  runFileTerminal.sendText(cmd, true);
  runFileTerminal.show(true);
}

let runFileTerminal: vscode.Terminal | undefined;

/** Called when a terminal is closed; clears runFileTerminal if it was that terminal. */
export function clearRunFileTerminalIf(terminal: vscode.Terminal): void {
  if (terminal === runFileTerminal) runFileTerminal = undefined;
}

let replTerminal: vscode.Terminal | undefined;

export async function getReplTerminal(context?: vscode.ExtensionContext): Promise<vscode.Terminal> {
  if (replTerminal) {
    const alive = vscode.window.terminals.some(t => t === replTerminal);
    if (alive) return replTerminal;
    replTerminal = undefined;
  }

  const device = getConfiguredDevice();
  if (!device) {
    throw new Error("Select a specific serial port first (not 'auto')");
  }

  // Launch the configured Python interpreter directly as the terminal process.
  // No shell is involved, so there is nothing to quote on any platform.
  const pythonPath = await getPythonPath(vscode.workspace.workspaceFolders?.[0]);
  replTerminal = vscode.window.createTerminal({
    name: "ESP32 REPL",
    shellPath: pythonPath,
    shellArgs: ["-m", "mpremote", "connect", device],
    env: { PYTHONIOENCODING: "utf-8" }
  });

  // Send interrupt (Ctrl-C) to ensure device is responsive
  setTimeout(() => {
    if (replTerminal) {
      replTerminal.sendText("\x03", false); // Ctrl-C
      // Small delay then send Ctrl-B for friendly REPL
      setTimeout(() => {
        if (replTerminal) {
          replTerminal.sendText("\x02", false); // Ctrl-B
        }
      }, 100);
    }
  }, 500); // Wait 500ms for terminal to initialize

  return replTerminal;
}

export function isReplOpen(): boolean {
  if (!replTerminal) return false;
  return vscode.window.terminals.some(t => t === replTerminal);
}

export async function closeReplTerminal() {
  if (replTerminal) {
    try {
      replTerminal.dispose();
    } catch {}
    replTerminal = undefined;
    await new Promise(r => setTimeout(r, 300));
  }
}

export async function openReplTerminal() {
  // Strict handshake like Thonny: ensure device is interrupted and responsive before opening REPL
  const cfg = vscode.workspace.getConfiguration();
  const interrupt = cfg.get<boolean>("mpyWorkbench.interruptOnConnect", true);
  const strict = cfg.get<boolean>("mpyWorkbench.strictConnect", true);
  let lastError: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (strict) {
        await strictConnectHandshake(interrupt);
      } else if (interrupt) {
        try { await mp.reset(); } catch {}
      }
      const term = await getReplTerminal();
      term.show(true);
      // tiny delay to ensure terminal connects before next action
      await new Promise(r => setTimeout(r, 150));
      return;
    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || err).toLowerCase();
      if (
        msg.includes("device not configured") ||
        msg.includes("serialexception") ||
        msg.includes("serial port not found") ||
        msg.includes("read failed")
      ) {
        // Wait and retry once
        if (attempt === 1) await new Promise(r => setTimeout(r, 1200));
        else throw err;
      } else {
        throw err;
      }
    }
  }
  if (lastError) throw lastError;
}

async function strictConnectHandshake(interrupt: boolean) {
  // Try reset + quick op, retry once if needed
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (interrupt) await mp.reset();
      // quick check: ls root; if it returns without throwing, we assume we're good
      await mp.ls("/");
      return;
    } catch (e) {
      if (attempt === 2) break;
      // small backoff then retry
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

/** Absolute local folder that mirrors the board (workspace root or mpyWorkbench.localRoot). */
export function getSyncRoot(ws: vscode.WorkspaceFolder): string {
  const localRoot = vscode.workspace.getConfiguration("mpyWorkbench", ws.uri).get<string>("localRoot", "");
  return resolveSyncRoot(ws.uri.fsPath, localRoot);
}

export function toLocalRelative(devicePath: string, rootPath: string): string {
  const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
  if (normRoot === "/") return devicePath.replace(/^\//, "");
  if (devicePath.startsWith(normRoot + "/")) return devicePath.slice(normRoot.length + 1);
  if (devicePath === normRoot) return "";
  // Fallback: strip leading slash
  return devicePath.replace(/^\//, "");
}

export function toDevicePath(localRel: string, rootPath: string): string {
  const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
  if (normRoot === "/") return "/" + localRel;
  return normRoot + "/" + localRel;
}

function resolveDevicePort(port?: string): string {
  if (port) return port;
  const device = getConfiguredDevice();
  if (!device) throw new Error("Select a specific serial port first (not 'auto').");
  return device;
}

async function warnIfUnhealthy(devicePort: string): Promise<void> {
  try {
    const health = await mp.healthCheck(devicePort);
    if (!health.healthy) {
      log.warn(`Device at ${devicePort} is not healthy, proceeding anyway`);
      vscode.window.showWarningMessage(`Device at ${devicePort} may not be responding properly.`);
    } else {
      log.debug(`Device at ${devicePort} is healthy (response time: ${health.responseTime}ms)`);
    }
  } catch (error) {
    log.warn(`Health check failed for ${devicePort}, proceeding:`, error);
  }
}

/** Send Ctrl-C twice: direct serial write first, mpremote as fallback. Returns true on success. */
async function sendInterrupt(devicePort: string, throwOnFailure: boolean): Promise<boolean> {
  try {
    await writeRawToSerialPort(devicePort, Buffer.from([0x03, 0x03]));
    log.debug(`Interrupt written directly to ${devicePort}`);
    vscode.window.showInformationMessage(`Board: Interrupt sent to ${devicePort}`);
    return true;
  } catch (error) {
    log.debug(`Direct serial interrupt failed (${error}), trying mpremote`);
    try {
      await mp.runMpremote(["connect", devicePort, "exec", "--no-follow", "import sys; sys.stdin.write(b'\\x03\\x03')"]);
      vscode.window.showInformationMessage(`Board: Interrupt sent via mpremote to ${devicePort}`);
      return true;
    } catch (error2) {
      const msg = `Board: Interrupt failed for ${devicePort}: direct write error: ${error}, mpremote error: ${error2}`;
      log.error(msg);
      vscode.window.showErrorMessage(msg);
      if (throwOnFailure) throw new Error(msg);
      return false;
    }
  }
}

/** Send Ctrl-D (soft reset): direct serial write first, `mpremote reset` as fallback. */
async function sendSoftReset(devicePort: string): Promise<void> {
  try {
    await writeRawToSerialPort(devicePort, Buffer.from([0x04]));
    log.debug(`Soft reset written directly to ${devicePort}`);
    vscode.window.showInformationMessage(`Board: Soft reset sent to ${devicePort}`);
  } catch (error) {
    log.debug(`Direct serial reset failed (${error}), trying mpremote reset`);
    try {
      await mp.runMpremote(["connect", devicePort, "reset"]);
      vscode.window.showInformationMessage(`Board: Soft reset sent via mpremote to ${devicePort}`);
    } catch (error2) {
      const msg = `Board: Soft reset failed for ${devicePort}: direct write error: ${error}, mpremote error: ${error2}`;
      log.error(msg);
      vscode.window.showErrorMessage(msg);
      throw new Error(msg);
    }
  }
}

export async function robustInterrupt(port?: string): Promise<void> {
  const devicePort = resolveDevicePort(port);
  await warnIfUnhealthy(devicePort);
  await sendInterrupt(devicePort, true);
}

export async function robustInterruptAndReset(port?: string): Promise<void> {
  const devicePort = resolveDevicePort(port);
  await warnIfUnhealthy(devicePort);
  // Continue to the reset even if the interrupt fails.
  await sendInterrupt(devicePort, false);
  await sendSoftReset(devicePort);
}
