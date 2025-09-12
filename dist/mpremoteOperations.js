"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
exports.mvOnDevice = mvOnDevice;
exports.clearFileTreeCache = clearFileTreeCache;
exports.refreshFileTreeCache = refreshFileTreeCache;
exports.debugTreeParsing = debugTreeParsing;
exports.debugFilesystemStatus = debugFilesystemStatus;
exports.getFileTreeCacheStats = getFileTreeCacheStats;
// Placeholder exports to make this a valid module
async function ls(p) {
    return "";
}
async function lsTyped(p) {
    return [];
}
async function listSerialPorts() {
    return [];
}
async function mkdir(p) {
    // Implementation
}
async function cpFromDevice(devicePath, localPath) {
    // Implementation
}
async function cpToDevice(localPath, devicePath) {
    // Implementation
}
async function uploadReplacing(localPath, devicePath) {
    // Implementation
}
async function deleteFile(p) {
    // Implementation
}
async function deleteAny(p) {
    // Implementation
}
async function deleteFolderRecursive(p) {
    // Implementation
}
async function fileExists(p) {
    return false;
}
async function getFileInfo(p) {
    return null;
}
async function deleteAllInPath(rootPath) {
    return { deleted: [], errors: [], deleted_count: 0, error_count: 0 };
}
async function runFile(localPath) {
    return { stdout: "", stderr: "" };
}
async function reset() {
    // Implementation
}
async function listTreeStats(root) {
    return [];
}
async function mvOnDevice(src, dst) {
    // Implementation
}
function clearFileTreeCache() {
    // Implementation
}
async function refreshFileTreeCache() {
    // Implementation
}
async function debugTreeParsing() {
    // Implementation
}
async function debugFilesystemStatus() {
    // Implementation
}
function getFileTreeCacheStats() {
    return {
        isValid: false,
        age: 0,
        itemCount: 0,
        lastUpdate: 0
    };
}
//# sourceMappingURL=mpremoteOperations.js.map