"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.disconnectReplTerminal = disconnectReplTerminal;
exports.restartReplInExistingTerminal = restartReplInExistingTerminal;
exports.checkMpremoteAvailability = checkMpremoteAvailability;
exports.serialSendCtrlC = serialSendCtrlC;
exports.stop = stop;
exports.softReset = softReset;
exports.runActiveFile = runActiveFile;
exports.getReplTerminal = getReplTerminal;
exports.isReplOpen = isReplOpen;
exports.closeReplTerminal = closeReplTerminal;
exports.openReplTerminal = openReplTerminal;
exports.toLocalRelative = toLocalRelative;
const vscode = require("vscode");
const node_child_process_1 = require("node:child_process");
const mp = require("./mpremote");
// Disconnect the ESP32 REPL terminal but leave it open
async function disconnectReplTerminal() {
    if (replTerminal) {
        try {
            // For mpremote, send Ctrl-X to exit cleanly
            replTerminal.sendText("\x18", false); // Ctrl-X
            await new Promise(r => setTimeout(r, 200));
        }
        catch { }
    }
}
async function restartReplInExistingTerminal() {
    if (!replTerminal)
        return;
    try {
        const connect = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
        if (!connect || connect === "auto")
            return;
        const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
        // Simply restart mpremote connect command
        const cmd = `mpremote connect ${device}`;
        if (replTerminal)
            replTerminal.sendText(cmd, true);
        await new Promise(r => setTimeout(r, 200));
    }
    catch { }
}
async function checkMpremoteAvailability() {
    return new Promise((resolve, reject) => {
        (0, node_child_process_1.exec)('mpremote --version', (err, stdout, stderr) => {
            if (err) {
                vscode.window.showWarningMessage('mpremote not found. Please install mpremote: pip install mpremote');
                reject(err);
            }
            else {
                resolve();
            }
        });
    });
}
async function serialSendCtrlC() {
    const connect = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
    if (!connect || connect === "auto") {
        vscode.window.showWarningMessage("Select a specific serial port first (not 'auto').");
        return;
    }
    // Prefer using REPL terminal if open to avoid port conflicts and return to friendly REPL
    if (isReplOpen()) {
        try {
            const term = await getReplTerminal();
            term.sendText("\x03", false); // Ctrl-C interrupt
            await new Promise(r => setTimeout(r, 60));
            term.sendText("\x02", false); // Ctrl-B friendly REPL
            vscode.window.showInformationMessage("Board: Interrupt sequence (Ctrl-C, Ctrl-B) sent via REPL");
            return;
        }
        catch { }
    }
    // Use mpremote to send interrupt sequence
    const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
    const cmd = `mpremote connect ${device} exec "import machine; machine.reset()"`;
    await new Promise((resolve) => {
        (0, node_child_process_1.exec)(cmd, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Board: Interrupt sequence failed: ${stderr || error.message}`);
            }
            else {
                vscode.window.showInformationMessage(`Board: Interrupt sequence sent to ${device}`);
            }
            resolve();
        });
    });
    // No auto-refresh here
}
async function stop() {
    const cfg = vscode.workspace.getConfiguration();
    const connect = cfg.get("mpyWorkbench.connect", "auto");
    if (!connect || connect === "auto") {
        vscode.window.showWarningMessage("Select a specific serial port first (not 'auto').");
        return;
    }
    const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
    // If REPL terminal is open, prefer sending through it to avoid port conflicts
    if (isReplOpen()) {
        try {
            const term = await getReplTerminal();
            term.sendText("\x03", false); // Ctrl-C
            await new Promise(r => setTimeout(r, 60));
            term.sendText("\x01", false); // Ctrl-A (raw repl)
            await new Promise(r => setTimeout(r, 60));
            term.sendText("\x04", false); // Ctrl-D (soft reboot)
            vscode.window.showInformationMessage("Board: Stop sequence sent via REPL");
            return;
        }
        catch (e) {
            // fall back to mpremote below
        }
    }
    // Use mpremote to send stop sequence
    const cmd2 = `mpremote connect ${device} exec "import machine; machine.reset()"`;
    await new Promise((resolve) => {
        (0, node_child_process_1.exec)(cmd2, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Board: Stop sequence failed: ${stderr || error.message}`);
            }
            else {
                vscode.window.showInformationMessage(`Board: Stop sequence sent to ${device}`);
            }
            resolve();
        });
    });
}
async function softReset() {
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
        }
        catch {
            // fall back to mpremote below
        }
    }
    // Use mpremote connect auto reset
    const cmd = `mpremote connect auto reset`;
    await new Promise((resolve) => {
        (0, node_child_process_1.exec)(cmd, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Board: Soft reset failed: ${stderr || error.message}`);
            }
            else {
                vscode.window.showInformationMessage(`Board: Soft reset sent via mpremote connect auto reset`);
            }
            resolve();
        });
    });
}
async function runActiveFile() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
        vscode.window.showErrorMessage("No active editor");
        return;
    }
    await ed.document.save();
    const connect = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
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
let replTerminal;
async function getReplTerminal(context) {
    if (replTerminal) {
        const alive = vscode.window.terminals.some(t => t === replTerminal);
        if (alive)
            return replTerminal;
        replTerminal = undefined;
    }
    const connect = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
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
function isReplOpen() {
    if (!replTerminal)
        return false;
    return vscode.window.terminals.some(t => t === replTerminal);
}
async function closeReplTerminal() {
    if (replTerminal) {
        try {
            replTerminal.dispose();
        }
        catch { }
        replTerminal = undefined;
        await new Promise(r => setTimeout(r, 300));
    }
}
async function openReplTerminal() {
    // Strict handshake like Thonny: ensure device is interrupted and responsive before opening REPL
    const cfg = vscode.workspace.getConfiguration();
    const interrupt = cfg.get("mpyWorkbench.interruptOnConnect", true);
    const strict = cfg.get("mpyWorkbench.strictConnect", true);
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            if (strict) {
                await strictConnectHandshake(interrupt);
            }
            else if (interrupt) {
                try {
                    await mp.reset();
                }
                catch { }
            }
            const term = await getReplTerminal();
            term.show(true);
            // tiny delay to ensure terminal connects before next action
            await new Promise(r => setTimeout(r, 150));
            return;
        }
        catch (err) {
            lastError = err;
            const msg = String(err?.message || err).toLowerCase();
            if (msg.includes("device not configured") ||
                msg.includes("serialexception") ||
                msg.includes("serial port not found") ||
                msg.includes("read failed")) {
                // Wait and retry once
                if (attempt === 1)
                    await new Promise(r => setTimeout(r, 1200));
                else
                    throw err;
            }
            else {
                throw err;
            }
        }
    }
    if (lastError)
        throw lastError;
}
async function strictConnectHandshake(interrupt) {
    // Try reset + quick op, retry once if needed
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            if (interrupt)
                await mp.reset();
            // quick check: ls root; if it returns without throwing, we assume we're good
            await mp.ls("/");
            return;
        }
        catch (e) {
            if (attempt === 2)
                break;
            // small backoff then retry
            await new Promise(r => setTimeout(r, 200));
        }
    }
}
function toLocalRelative(devicePath, rootPath) {
    const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
    if (normRoot === "/")
        return devicePath.replace(/^\//, "");
    if (devicePath.startsWith(normRoot + "/"))
        return devicePath.slice(normRoot.length + 1);
    if (devicePath === normRoot)
        return "";
    // Fallback: strip leading slash
    return devicePath.replace(/^\//, "");
}
//# sourceMappingURL=mpremoteCommands.js.map