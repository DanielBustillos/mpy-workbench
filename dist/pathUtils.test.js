"use strict";
/**
 * Test file for pathUtils functions
 * Run with: mpyWorkbench.testPathUtils command
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPathUtilsTests = runPathUtilsTests;
exports.testPathUtils = runPathUtilsTests;
const pathUtils_1 = require("./pathUtils");
async function runPathUtilsTests() {
    console.log("=== MPY Workbench PathUtils Test Suite ===\n");
    // Test normalizePath
    console.log("1. Testing normalizePath function:");
    const normalizeTests = [
        { input: "/path//to///file", expected: "/path/to/file" },
        { input: "path/to/file/", expected: "path/to/file" },
        { input: "/", expected: "/" },
        { input: "", expected: "" },
        { input: "///", expected: "/" },
        { input: "path/", expected: "path" },
    ];
    for (const test of normalizeTests) {
        const result = (0, pathUtils_1.normalizePath)(test.input);
        const passed = result === test.expected;
        console.log(`  normalizePath("${test.input}") = "${result}" ${passed ? "✓" : "✗"} (expected: "${test.expected}")`);
    }
    console.log("\n2. Testing path conversion functions:");
    // Test cases for path conversion
    const conversionTests = [
        {
            local: "main.py",
            root: "/",
            expectedDevice: "/main.py",
            expectedLocal: "main.py",
            description: "Root directory file"
        },
        {
            local: "lib/utils.py",
            root: "/",
            expectedDevice: "/lib/utils.py",
            expectedLocal: "lib/utils.py",
            description: "Subdirectory file"
        },
        {
            local: "main.py",
            root: "/app",
            expectedDevice: "/app/main.py",
            expectedLocal: "main.py",
            description: "Custom root directory"
        },
        {
            local: "lib/utils.py",
            root: "/app",
            expectedDevice: "/app/lib/utils.py",
            expectedLocal: "lib/utils.py",
            description: "Custom root subdirectory"
        },
        {
            local: "",
            root: "/",
            expectedDevice: "/",
            expectedLocal: "",
            description: "Empty local path"
        },
    ];
    for (const test of conversionTests) {
        console.log(`  ${test.description}:`);
        const deviceResult = (0, pathUtils_1.toDevicePath)(test.local, test.root);
        const localResult = (0, pathUtils_1.relFromDevice)(deviceResult, test.root);
        const deviceMatch = deviceResult === test.expectedDevice;
        const localMatch = localResult === test.expectedLocal;
        const roundTripOk = localResult === test.local;
        console.log(`    Local: "${test.local}" -> Device: "${deviceResult}" ${deviceMatch ? "✓" : "✗"}`);
        console.log(`    Device: "${deviceResult}" -> Local: "${localResult}" ${localMatch ? "✓" : "✗"}`);
        console.log(`    Round-trip: ${roundTripOk ? "✓" : "✗"}`);
        if (!deviceMatch || !localMatch || !roundTripOk) {
            console.log(`    Expected: Local "${test.local}" <-> Device "${test.expectedDevice}"`);
            (0, pathUtils_1.debugPathConversion)(test.local, test.root, `Test failure: ${test.description}`);
        }
    }
    console.log("\n3. Testing path validation:");
    const validationTests = [
        { path: "/main.py", root: "/", expected: true, description: "Valid root file" },
        { path: "/lib/utils.py", root: "/", expected: true, description: "Valid subdirectory file" },
        { path: "/app/main.py", root: "/app", expected: true, description: "Valid custom root file" },
        { path: "main.py", root: "/", expected: false, description: "Invalid relative path" },
        { path: "", root: "/", expected: false, description: "Empty path" },
    ];
    for (const test of validationTests) {
        const result = (0, pathUtils_1.validatePathConversion)(test.path, test.root);
        const passed = result === test.expected;
        console.log(`  ${test.description}: validatePathConversion("${test.path}", "${test.root}") = ${result} ${passed ? "✓" : "✗"}`);
    }
    console.log("\n4. Testing tree comparison functions:");
    // Mock data for testing
    const mockLocalFiles = ["main.py", "lib/utils.py", "config/settings.py"];
    const mockBoardStats = [
        { path: "/main.py", size: 100, mtime: Date.now(), isDir: false },
        { path: "/lib/utils.py", size: 200, mtime: Date.now(), isDir: false },
        { path: "/config", size: 0, mtime: Date.now(), isDir: true },
        { path: "/config/settings.py", size: 150, mtime: Date.now(), isDir: false },
        { path: "/extra.py", size: 50, mtime: Date.now(), isDir: false },
    ];
    const mockBoardTree = (0, pathUtils_1.createBoardTreeData)(mockBoardStats, "/");
    console.log("  Mock local files:", mockLocalFiles);
    console.log("  Mock board files:", mockBoardTree.files.map(f => f.path));
    (0, pathUtils_1.debugTreeComparison)(mockLocalFiles, mockBoardTree, "/");
    console.log("\n=== Test Suite Complete ===");
    console.log("Check the console output above for detailed results.");
    console.log("Look for ✗ symbols indicating failed tests.");
}
//# sourceMappingURL=pathUtils.test.js.map