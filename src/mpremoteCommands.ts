import * as vscode from "vscode";
import { exec, execFile } from "node:child_process";
import * as path from "node:path";
import * as mp from "./mpremote";
import { getMpremoteExecOptions } from "./mpremote";
import { getPythonPath } from "./pythonInterpreter";

function shellEscape(arg: string): string {
  const escaped = arg.replace(/"/g, '\\"');
  if (arg.includes(" ")) {
    return `"${escaped}"`;
  }
  return escaped;
}

async function buildMpremoteTerminalCommand(args: string[]): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  const pythonPath = await getPythonPath(ws);
  const escapedArgs = args.map(shellEscape).join(" ");
  return `${shellEscape(pythonPath)} -m mpremote ${escapedArgs}`;
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
    const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
    if (!connect || connect === "auto") return;
    const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");

    // Restart using configured Python interpreter so mpremote does not depend on PATH
    const cmd = await buildMpremoteTerminalCommand(["connect", device]);
    if (replTerminal) replTerminal.sendText(cmd, true);
    await new Promise(r => setTimeout(r, 200));
  } catch {}
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
          vscode.window.showWarningMessage('mpremote no encontrado en el intérprete Python activo. Instálalo con: python -m pip install mpremote');
          reject(err);
          return;
        }
        const output = String(stdout || '').trim() + String(stderr || '').trim();
        const parsed = parseMpremoteVersion(output);
        if (parsed && !isVersionAtLeast(parsed, MPREMOTE_MIN_VERSION)) {
          const versionStr = parsed.join('.');
          vscode.window.showWarningMessage(
            `mpremote ${versionStr} detectado. Esta extensión requiere mpremote >= 1.26 para Upload/Download/Check for differences.`,
            'Cómo actualizar'
          ).then((choice) => {
            if (choice === 'Cómo actualizar') {
              openReadmeForUpdate();
            }
          });
        }
        resolve();
      });
    }).catch((err) => {
      if (err) {
        vscode.window.showWarningMessage('No se pudo resolver el intérprete Python activo para validar mpremote.');
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
    console.error(`[DEBUG] serialSendCtrlC: robustInterrupt failed: ${error}`);
  }
}

export async function stop(): Promise<void> {
  // Use the robust interrupt and reset function
  try {
    await robustInterruptAndReset();
  } catch (error: any) {
    // The robust function already handles errors and shows messages
    console.error(`[DEBUG] stop: robustInterruptAndReset failed: ${error}`);
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
  const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
  const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  const cmd = await buildMpremoteTerminalCommand(["connect", device, "reset"]);
  const opts = getMpremoteExecOptions();
  await new Promise<void>((resolve) => {
    exec(cmd, opts, (error: any, stdout: any, stderr: any) => {
      if (error) {
        vscode.window.showErrorMessage(`Board: Soft reset failed: ${stderr || error.message}`);
      } else {
        vscode.window.showInformationMessage(`Board: Soft reset sent via mpremote connect auto reset`);
      }
      resolve();
    });
  });
}

export async function runActiveFile(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showErrorMessage("No active editor"); return; }
  await ed.document.save();

  const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
  if (!connect || connect === "auto") {
    vscode.window.showErrorMessage("Select a specific serial port first (not 'auto').");
    return;
  }

  const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
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
    const rel = path.relative(ws.uri.fsPath, filePath).replace(/\\/g, "/");
    if (rel.startsWith("..")) {
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

  const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
  if (!connect || connect === "auto") {
    throw new Error("Select a specific serial port first (not 'auto')");
  }

  const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");

  // Execute using configured Python interpreter so mpremote does not depend on PATH
  const cmd = await buildMpremoteTerminalCommand(["connect", device]);
  replTerminal = vscode.window.createTerminal({
    name: "ESP32 REPL",
    shellPath: process.platform === 'win32' ? "cmd.exe" : (process.env.SHELL || '/bin/bash'),
    shellArgs: process.platform === 'win32' ? ["/d", "/c", cmd] : ["-lc", cmd]
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

export async function robustInterrupt(port?: string): Promise<void> {
  // Get port from parameter or config
  let devicePort: string;
  if (port) {
    devicePort = port;
  } else {
    const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
    if (!connect || connect === "auto") {
      throw new Error("Select a specific serial port first (not 'auto').");
    }
    devicePort = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  }

  console.log(`[DEBUG] robustInterrupt: Starting for port ${devicePort}`);

  // Check device connection
  try {
    const health = await mp.healthCheck(devicePort);
    if (!health.healthy) {
      console.warn(`[DEBUG] robustInterrupt: Device at ${devicePort} is not healthy, but proceeding...`);
      vscode.window.showWarningMessage(`Device at ${devicePort} may not be responding properly.`);
    } else {
      console.log(`[DEBUG] robustInterrupt: Device at ${devicePort} is healthy (response time: ${health.responseTime}ms)`);
    }
  } catch (error) {
    console.warn(`[DEBUG] robustInterrupt: Health check failed: ${error}, proceeding...`);
  }

  // Interrupt with Ctrl+C twice
  try {
    console.log(`[DEBUG] robustInterrupt: Attempting interrupt via echo to ${devicePort}`);
    await new Promise<void>((resolve, reject) => {
      exec(`echo -e '\\x03\\x03' > ${devicePort}`, (error, stdout, stderr) => {
        if (error) {
          console.log(`[DEBUG] robustInterrupt: echo interrupt failed: ${stderr || error.message}`);
          reject(error);
        } else {
          console.log(`[DEBUG] robustInterrupt: echo interrupt succeeded`);
          resolve();
        }
      });
    });
    vscode.window.showInformationMessage(`Board: Interrupt sent via echo to ${devicePort}`);
  } catch (error) {
    console.log(`[DEBUG] robustInterrupt: Interrupt via echo failed: ${error}, trying mpremote`);
    vscode.window.showWarningMessage(`Board: Direct serial interrupt failed, trying mpremote fallback...`);
    try {
      await mp.runMpremote(["connect", devicePort, "exec", "--no-follow", "import sys; sys.stdin.write(b'\\x03\\x03')"]);
      console.log(`[DEBUG] robustInterrupt: Interrupt via mpremote succeeded`);
      vscode.window.showInformationMessage(`Board: Interrupt sent via mpremote to ${devicePort}`);
    } catch (error2) {
      console.error(`[DEBUG] robustInterrupt: Interrupt via mpremote also failed: ${error2}`);
      vscode.window.showErrorMessage(`Board: Interrupt failed for ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
      throw new Error(`Failed to interrupt device on ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
    }
  }

  console.log(`[DEBUG] robustInterrupt: Completed for port ${devicePort}`);
}

export async function robustInterruptAndReset(port?: string): Promise<void> {
  // Get port from parameter or config
  let devicePort: string;
  if (port) {
    devicePort = port;
  } else {
    const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
    if (!connect || connect === "auto") {
      throw new Error("Select a specific serial port first (not 'auto').");
    }
    devicePort = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  }

  console.log(`[DEBUG] robustInterruptAndReset: Starting for port ${devicePort}`);

  // Check device connection
  try {
    const health = await mp.healthCheck(devicePort);
    if (!health.healthy) {
      console.warn(`[DEBUG] robustInterruptAndReset: Device at ${devicePort} is not healthy, but proceeding...`);
      vscode.window.showWarningMessage(`Device at ${devicePort} may not be responding properly.`);
    } else {
      console.log(`[DEBUG] robustInterruptAndReset: Device at ${devicePort} is healthy (response time: ${health.responseTime}ms)`);
    }
  } catch (error) {
    console.warn(`[DEBUG] robustInterruptAndReset: Health check failed: ${error}, proceeding...`);
  }

  // Step 1: Interrupt with Ctrl+C twice
  let interruptSuccess = false;
  try {
    console.log(`[DEBUG] robustInterruptAndReset: Attempting interrupt via echo to ${devicePort}`);
    await new Promise<void>((resolve, reject) => {
      exec(`echo -e '\\x03\\x03' > ${devicePort}`, (error, stdout, stderr) => {
        if (error) {
          console.log(`[DEBUG] robustInterruptAndReset: echo interrupt failed: ${stderr || error.message}`);
          reject(error);
        } else {
          console.log(`[DEBUG] robustInterruptAndReset: echo interrupt succeeded`);
          resolve();
        }
      });
    });
    interruptSuccess = true;
    vscode.window.showInformationMessage(`Board: Interrupt sent via echo to ${devicePort}`);
  } catch (error) {
    console.log(`[DEBUG] robustInterruptAndReset: Interrupt via echo failed: ${error}, trying mpremote`);
    vscode.window.showWarningMessage(`Board: Direct serial interrupt failed, trying mpremote fallback...`);
    try {
      await mp.runMpremote(["connect", devicePort, "exec", "--no-follow", "import sys; sys.stdin.write(b'\\x03\\x03')"]);
      console.log(`[DEBUG] robustInterruptAndReset: Interrupt via mpremote succeeded`);
      interruptSuccess = true;
      vscode.window.showInformationMessage(`Board: Interrupt sent via mpremote to ${devicePort}`);
    } catch (error2) {
      console.error(`[DEBUG] robustInterruptAndReset: Interrupt via mpremote also failed: ${error2}`);
      vscode.window.showErrorMessage(`Board: Interrupt failed for ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
      // Continue to reset even if interrupt fails
    }
  }

  // Step 2: Soft reset with Ctrl+D
  try {
    console.log(`[DEBUG] robustInterruptAndReset: Attempting soft reset via echo to ${devicePort}`);
    await new Promise<void>((resolve, reject) => {
      exec(`echo -e '\\x04' > ${devicePort}`, (error, stdout, stderr) => {
        if (error) {
          console.log(`[DEBUG] robustInterruptAndReset: echo reset failed: ${stderr || error.message}`);
          reject(error);
        } else {
          console.log(`[DEBUG] robustInterruptAndReset: echo reset succeeded`);
          resolve();
        }
      });
    });
    vscode.window.showInformationMessage(`Board: Soft reset sent via echo to ${devicePort}`);
  } catch (error) {
    console.log(`[DEBUG] robustInterruptAndReset: Soft reset via echo failed: ${error}, trying mpremote reset`);
    vscode.window.showWarningMessage(`Board: Direct serial reset failed, trying mpremote fallback...`);
    try {
      await mp.runMpremote(["connect", devicePort, "reset"]);
      console.log(`[DEBUG] robustInterruptAndReset: Soft reset via mpremote succeeded`);
      vscode.window.showInformationMessage(`Board: Soft reset sent via mpremote to ${devicePort}`);
    } catch (error2) {
      console.error(`[DEBUG] robustInterruptAndReset: Soft reset via mpremote also failed: ${error2}`);
      vscode.window.showErrorMessage(`Board: Soft reset failed for ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
      throw new Error(`Failed to reset device on ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
    }
  }

  console.log(`[DEBUG] robustInterruptAndReset: Completed for port ${devicePort}`);
}