"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mvOnDevice = mvOnDevice;
exports.setSerialNoticeSuppressed = setSerialNoticeSuppressed;
exports.ls = ls;
exports.lsTyped = lsTyped;
exports.listSerialPorts = listSerialPorts;
exports.mkdir = mkdir;
exports.cpFromDevice = cpFromDevice;
exports.cpToDevice = cpToDevice;
exports.uploadReplacing = uploadReplacing;
exports.deleteFile = deleteFile;
exports.deleteAny = deleteAny;
exports.deleteFolderRecursive = deleteFolderRecursive;
exports.fileExists = fileExists;
exports.getFileInfo = getFileInfo;
exports.deleteAllInPath = deleteAllInPath;
exports.runFile = runFile;
exports.reset = reset;
exports.listTreeStats = listTreeStats;
exports.cancelAll = cancelAll;
async function mvOnDevice(src, dst) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    try {
        await runTool(["mv", "--port", connect, "--src", src, "--dst", dst]);
    }
    catch (error) {
        throw new Error(`Rename failed: ${error?.message || error}`);
    }
}
const node_child_process_1 = require("node:child_process");
const vscode = require("vscode");
const path = require("node:path");
function normalizeConnect(c) {
    if (c.startsWith("serial://"))
        return c.replace(/^serial:\/\//, "");
    if (c.startsWith("serial:/"))
        return c.replace(/^serial:\//, "");
    return c;
}
function toolPath() {
    const ext = vscode.extensions.getExtension("DanielBucam.mpy-workbench");
    if (!ext) {
        vscode.window.showWarningMessage("No se encontró la extensión 'mpy-workbench'. Verifica el campo 'publisher' y 'name' en tu package.json.");
        throw new Error("Extension not found for tool path");
    }
    return path.join(ext.extensionPath, "scripts", "pyserial_tool.py");
}
let currentChild = null;
let lastDisconnectNotice = 0;
const DISCONNECT_COOLDOWN_MS = 6000;
let suppressSerialNotices = false;
function setSerialNoticeSuppressed(s) {
    suppressSerialNotices = s;
}
function isDisconnectMessage(msg) {
    const m = msg.toLowerCase();
    return (m.includes("device disconnected") ||
        m.includes("serial read returned no data") ||
        m.includes("device reports readiness to read") ||
        m.includes("device not configured") ||
        m.includes("serial device not available") ||
        m.includes("no such file or directory") ||
        m.includes("serial port not found"));
}
function isBusyMessage(msg) {
    const m = msg.toLowerCase();
    return (m.includes("resource busy") ||
        m.includes("permission denied") ||
        m.includes("port is already open") ||
        m.includes("busy or permission denied") ||
        m.includes("could not open port") ||
        m.includes("could not open serial port"));
}
function maybeNotifySerialStatus(msg) {
    if (suppressSerialNotices)
        return;
    const busy = isBusyMessage(msg);
    const disc = isDisconnectMessage(msg);
    if (!busy && !disc)
        return;
    const now = Date.now();
    if (now - lastDisconnectNotice < DISCONNECT_COOLDOWN_MS)
        return;
    lastDisconnectNotice = now;
    if (busy) {
        vscode.window.showWarningMessage("Puerto serie ocupado o sin permisos. Cierra otros monitores (Arduino, Thonny, miniterm) o revisa permisos.");
    }
    else {
        vscode.window.showWarningMessage("ESP32 desconectado o puerto no disponible. Verifica cable/alimentación y vuelve a seleccionar el puerto.");
    }
}
function runTool(args, opts = {}) {
    return new Promise((resolve, reject) => {
        const execOnce = (attempt) => {
            const cfg = vscode.workspace.getConfiguration();
            const baud = cfg.get("mpyWorkbench.baudRate", 115200) || 115200;
            const argsWithBaud = ["--baud", String(baud), ...args];
            const child = (0, node_child_process_1.execFile)("python3", [toolPath(), ...argsWithBaud], { cwd: opts.cwd }, (err, stdout, stderr) => {
                if (currentChild === child)
                    currentChild = null;
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
async function ls(p) {
    const cfg = vscode.workspace.getConfiguration();
    const connect = normalizeConnect(cfg.get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    const { stdout } = await runTool(["ls", "--port", connect, "--path", p]);
    return String(stdout || "");
}
async function lsTyped(p) {
    const cfg = vscode.workspace.getConfiguration();
    const connect = normalizeConnect(cfg.get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    const { stdout } = await runTool(["ls_typed", "--port", connect, "--path", p]);
    try {
        const arr = JSON.parse(String(stdout || "[]"));
        if (Array.isArray(arr))
            return arr;
    }
    catch { }
    return [];
}
async function listSerialPorts() {
    try {
        const { stdout } = await runTool(["devs"]);
        const ports = String(stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (ports.length === 0) {
            vscode.window.showWarningMessage("No serial ports detected. Verifica que Python y pyserial estén instalados en el entorno usado por la extensión.");
        }
        return ports;
    }
    catch (err) {
        vscode.window.showWarningMessage("Error executing Python script to detect ports: " + (err?.message || err));
        return [];
    }
}
async function mkdir(p) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    await runTool(["mkdir", "--port", connect, "--path", p]);
}
async function cpFromDevice(devicePath, localPath) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    await runTool(["cp_from", "--port", connect, "--src", devicePath, "--dst", localPath]);
}
async function cpToDevice(localPath, devicePath) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    await runTool(["cp_to", "--port", connect, "--src", localPath, "--dst", devicePath]);
}
async function uploadReplacing(localPath, devicePath) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    await runTool(["upload_replacing", "--port", connect, "--src", localPath, "--dst", devicePath]);
}
async function deleteFile(p) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    // Fast path: delete file or directory in a single call
    await runTool(["delete_any", "--port", connect, "--path", p]);
}
async function deleteAny(p) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    await runTool(["delete_any", "--port", connect, "--path", p]);
}
async function deleteFolderRecursive(p) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    await runTool(["delete_folder_recursive", "--port", connect, "--path", p]);
}
async function fileExists(p) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    try {
        const result = await runTool(["file_exists", "--port", connect, "--path", p]);
        const output = result.stdout.trim();
        return output === "exists";
    }
    catch (error) {
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
async function getFileInfo(p) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
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
    }
    catch (error) {
        return null;
    }
}
async function deleteAllInPath(rootPath) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    try {
        const { stdout } = await runTool(["wipe_path", "--port", connect, "--path", rootPath]);
        const s = String(stdout || "{}").trim();
        let obj = {};
        try {
            obj = JSON.parse(s);
        }
        catch {
            obj = {};
        }
        const deletedCount = typeof obj.deleted_count === 'number' ? obj.deleted_count : 0;
        const errorsArr = Array.isArray(obj.errors) ? obj.errors : [];
        return { deleted: new Array(deletedCount).fill(""), errors: errorsArr, deleted_count: deletedCount, error_count: errorsArr.length };
    }
    catch (error) {
        return { deleted: [], errors: [String(error?.message || error)], deleted_count: 0, error_count: 1 };
    }
}
async function runFile(localPath) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    const { stdout } = await runTool(["run_file", "--port", connect, "--src", localPath]);
    return { stdout: String(stdout || ""), stderr: "" };
}
async function reset() {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        return;
    try {
        await runTool(["reset", "--port", connect]);
    }
    catch { }
}
async function listTreeStats(root) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    const { stdout } = await runTool(["tree_stats", "--port", connect, "--path", root]);
    try {
        const arr = JSON.parse(String(stdout || "[]"));
        if (Array.isArray(arr))
            return arr;
    }
    catch { }
    return [];
}
function cancelAll() {
    try {
        currentChild?.kill('SIGKILL');
    }
    catch { }
    currentChild = null;
}
//# sourceMappingURL=mpremote.js.map