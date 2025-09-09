"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildManifest = buildManifest;
exports.diffManifests = diffManifests;
exports.saveManifest = saveManifest;
exports.loadManifest = loadManifest;
exports.cloneManifestWithNewId = cloneManifestWithNewId;
exports.defaultIgnorePatterns = defaultIgnorePatterns;
exports.createIgnoreMatcher = createIgnoreMatcher;
const fs = require("node:fs/promises");
const path = require("node:path");
const node_crypto_1 = require("node:crypto");
async function buildManifest(rootDir, ignore) {
    const matcher = (typeof ignore === 'function')
        ? ignore
        : ((rel, isDir) => ignore.has(rel.split('/').pop() || rel));
    const files = {};
    async function walk(dir, relBase = "") {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const rel = path.posix.join(relBase, e.name);
            const abs = path.join(dir, e.name);
            const isDir = e.isDirectory();
            if (matcher(rel, isDir))
                continue;
            if (isDir) {
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
function defaultIgnorePatterns() {
    return [
        ".git/",
        ".vscode/",
        "node_modules/",
        "dist/",
        "out/",
        "build/",
        "__pycache__/",
        ".DS_Store",
        ".mpy-workbench/",
        ".mpyignore"
    ];
}
function globToRegExp(pat) {
    // basics: * => [^/]*, ** => .* , ? => [^/]
    let pattern = pat.trim();
    const anchorRoot = pattern.startsWith('/');
    if (anchorRoot)
        pattern = pattern.slice(1);
    // Escape regex special chars EXCEPT glob tokens (*, ?, /)
    pattern = pattern.replace(/([.+^${}()|\[\]\\])/g, '\\$1');
    // Replace ** first
    pattern = pattern.replace(/\*\*/g, '.*');
    // Then * and ?
    pattern = pattern.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    const trailingSlash = pattern.endsWith('/');
    const core = trailingSlash ? pattern.slice(0, -1) : pattern;
    const prefix = anchorRoot ? '^' : '(^|.*/)';
    const suffix = trailingSlash ? '(?:/.*)?$' : '$';
    return new RegExp(prefix + core + suffix);
}
async function createIgnoreMatcher(rootDir) {
    const defaults = defaultIgnorePatterns();
    let extra = [];
    // Read workspace root ignore file
    try {
        const txt = await fs.readFile(path.join(rootDir, '.mpyignore'), 'utf8');
        extra.push(...txt.split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#')));
    }
    catch { }
    // Read workbench-local ignore file inside .mpy-workbench
    try {
        const txt2 = await fs.readFile(path.join(rootDir, '.mpy-workbench', '.mpyignore'), 'utf8');
        extra.push(...txt2.split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#')));
    }
    catch { }
    const patterns = [...defaults, ...extra];
    const regs = patterns.map(globToRegExp);
    return (relPath, isDir) => {
        const p = relPath.replace(/\\/g, '/');
        return regs.some(r => r.test(p));
    };
}
//# sourceMappingURL=sync.js.map