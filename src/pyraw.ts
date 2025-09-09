import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

export async function listDirPyRaw(dirPath: string): Promise<{ name: string; isDir: boolean }[]> {
  const cfg = vscode.workspace.getConfiguration();
  const connect = cfg.get<string>("mpyWorkbench.connect", "auto") || "auto";
  if (!connect || connect === "auto") throw new Error("No fixed serial port selected");
  const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  const script = path.join(vscode.extensions.getExtension("your-name.mpy-workbench")!.extensionPath, "scripts", "thonny_list_files.py");
  return new Promise((resolve, reject) => {
    execFile("python3", [script, "--port", device, "--baudrate", "115200", "--path", dirPath], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        const data = JSON.parse(String(stdout || "[]"));
        if (Array.isArray(data)) return resolve(data);
      } catch (e) {
        // fallthrough
      }
      resolve([]);
    });
  });
}
