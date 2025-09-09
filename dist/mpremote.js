"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ls = ls;
exports.lsTyped = lsTyped;
exports.listSerialPorts = listSerialPorts;
exports.mkdir = mkdir;
exports.rm = rm;
exports.cpFromDevice = cpFromDevice;
exports.cpToDevice = cpToDevice;
exports.uploadReplacing = uploadReplacing;
exports.rmrf = rmrf;
exports.runFile = runFile;
exports.reset = reset;
exports.listTreeStats = listTreeStats;
exports.cancelAll = cancelAll;
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
    const ext = vscode.extensions.getExtension("your-name.mpy-workbench");
    if (!ext)
        throw new Error("Extension not found for tool path");
    return path.join(ext.extensionPath, "scripts", "pyserial_tool.py");
}
let currentChild = null;
function runTool(args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.execFile)("python3", [toolPath(), ...args], { cwd: opts.cwd }, (err, stdout, stderr) => {
            if (currentChild === child)
                currentChild = null;
            if (err)
                return reject(new Error(stderr || err?.message || "tool error"));
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
        currentChild = child;
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
        return String(stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    catch {
        return [];
    }
}
async function mkdir(p) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    await runTool(["mkdir", "--port", connect, "--path", p]);
}
async function rm(p) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    await runTool(["rm", "--port", connect, "--path", p]);
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
async function rmrf(p) {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto") || "auto");
    if (!connect || connect === "auto")
        throw new Error("Select a specific serial port first");
    await runTool(["rmrf", "--port", connect, "--path", p]);
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