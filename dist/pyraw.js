"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDirPyRaw = listDirPyRaw;
const node_child_process_1 = require("node:child_process");
const path = require("node:path");
const vscode = require("vscode");
async function listDirPyRaw(dirPath) {
    const cfg = vscode.workspace.getConfiguration();
    const connect = cfg.get("esp32fs.connect", "auto") || "auto";
    if (!connect || connect === "auto")
        throw new Error("No fixed serial port selected");
    const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
    const script = path.join(vscode.extensions.getExtension("your-name.esp32-files-explorer").extensionPath, "scripts", "thonny_list_files.py");
    return new Promise((resolve, reject) => {
        (0, node_child_process_1.execFile)("python3", [script, "--port", device, "--baudrate", "115200", "--path", dirPath], { timeout: 10000 }, (err, stdout, stderr) => {
            if (err)
                return reject(new Error(stderr || err.message));
            try {
                const data = JSON.parse(String(stdout || "[]"));
                if (Array.isArray(data))
                    return resolve(data);
            }
            catch (e) {
                // fallthrough
            }
            resolve([]);
        });
    });
}
//# sourceMappingURL=pyraw.js.map