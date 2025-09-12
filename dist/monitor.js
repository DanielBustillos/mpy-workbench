"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitor = void 0;
const node_child_process_1 = require("node:child_process");
const vscode = require("vscode");
const pythonInterpreter_1 = require("./pythonInterpreter");
class SerialMonitor {
    constructor() {
        this.busy = false;
        this.running = false;
        this.intervalMs = 2000; // poll every 2s
        this.windowMs = 400; // read for 400ms
    }
    start() {
        if (this.running)
            return;
        this.out ?? (this.out = vscode.window.createOutputChannel("ESP32 Serial (Polling)"));
        this.running = true;
        this.schedule();
    }
    stop() {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    isRunning() { return this.running; }
    async suspendDuring(fn) {
        const wasRunning = this.running;
        this.busy = true;
        try {
            return await fn();
        }
        finally {
            this.busy = false;
            if (wasRunning)
                this.schedule();
        }
    }
    schedule() {
        if (!this.running || this.busy)
            return;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick().catch(() => { }), this.intervalMs);
    }
    async tick() {
        if (!this.running || this.busy)
            return;
        const connect = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
        const device = (connect || '').replace(/^serial:\/\//, "").replace(/^serial:\//, "");
        // Spawn a short-lived miniterm to read any pending output, then kill.
        const args = ["-m", "serial.tools.miniterm", device, "115200", "--eol", "LF"];
        const pythonPath = await (0, pythonInterpreter_1.getPythonPath)();
        const proc = (0, node_child_process_1.spawn)(pythonPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        let buf = "";
        let err = "";
        if (proc.stdout)
            proc.stdout.on("data", d => { buf += String(d); });
        if (proc.stderr)
            proc.stderr.on("data", d => { err += String(d); });
        const killTimer = setTimeout(() => { try {
            proc.kill("SIGKILL");
        }
        catch { } }, this.windowMs);
        await new Promise(resolve => proc.on("close", () => resolve()));
        clearTimeout(killTimer);
        // Append output if any (exclude echo noise)
        const text = (buf || err).trim();
        if (text) {
            this.out?.appendLine(text);
            // Do not steal focus by default; user can open manually from the Output dropdown
        }
        if (this.running && !this.busy)
            this.schedule();
    }
}
exports.monitor = new SerialMonitor();
//# sourceMappingURL=monitor.js.map