"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildManifest = buildManifest;
exports.diffManifests = diffManifests;
exports.saveManifest = saveManifest;
exports.loadManifest = loadManifest;
exports.cloneManifestWithNewId = cloneManifestWithNewId;
exports.defaultIgnore = defaultIgnore;
const fs = require("node:fs/promises");
const path = require("node:path");
const node_crypto_1 = require("node:crypto");
async function buildManifest(rootDir, ignore) {
    const files = {};
    async function walk(dir, relBase = "") {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            if (ignore.has(e.name))
                continue;
            const abs = path.join(dir, e.name);
            const rel = path.posix.join(relBase, e.name);
            if (e.isDirectory()) {
                await walk(abs, rel);
            }
            else if (e.isFile()) {
                const st = await fs.stat(abs);
                files[rel] = { size: st.size, mtime: Math.floor(st.mtimeMs) };
            }
        }
    }
    await walk(rootDir);
    return { version: 1, syncId: (0, node_crypto_1.randomUUID)(), root: rootDir, generatedAt: Date.now(), files };
}
function diffManifests(prev, next) {
    const changedOrNew = [];
    const deleted = [];
    for (const [p, e] of Object.entries(next.files)) {
        const pe = prev.files[p];
        if (!pe || pe.size !== e.size || pe.mtime !== e.mtime)
            changedOrNew.push(p);
    }
    for (const p of Object.keys(prev.files)) {
        if (!(p in next.files))
            deleted.push(p);
    }
    return { changedOrNew, deleted };
}
async function saveManifest(filePath, m) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(m, null, 2), "utf8");
}
async function loadManifest(filePath) {
    try {
        const txt = await fs.readFile(filePath, "utf8");
        return JSON.parse(txt);
    }
    catch {
        return undefined;
    }
}
function cloneManifestWithNewId(m, newId) {
    return { ...m, syncId: newId, generatedAt: Date.now() };
}
function defaultIgnore() {
    return new Set([".git", ".vscode", "node_modules", "dist", "out", "build", "__pycache__", ".DS_Store"]);
}
//# sourceMappingURL=sync.js.map