import * as vscode from "vscode";
import { exec } from "node:child_process";
import * as mp from "./mpremote";

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

    // Simply restart mpremote connect command
    const cmd = `mpremote connect ${device}`;
    if (replTerminal) replTerminal.sendText(cmd, true);
    await new Promise(r => setTimeout(r, 200));
  } catch {}
}

export async function checkMpremoteAvailability(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    exec('mpremote --version', (err: any, stdout: string, stderr: string) => {
      if (err) {
        vscode.window.showWarningMessage('mpremote not found. Please install mpremote: pip install mpremote');
        reject(err);
      } else {
        resolve();
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
  const cmd = `mpremote connect ${device} reset`;
  await new Promise<void>((resolve) => {
    exec(cmd, (error: any, stdout: any, stderr: any) => {
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

  // Create a new terminal to run the file with mpremote
  const runTerminal = vscode.window.createTerminal({
    name: "ESP32 Run File",
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  });

  // Use mpremote run command
  const cmd = `mpremote connect ${device} run "${filePath}"`;
  runTerminal.sendText(cmd, true);
  runTerminal.show(true);
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

  // Simply execute mpremote connect command in terminal
  const cmd = `mpremote connect ${device}`;
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