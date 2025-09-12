"use strict";
/**
 * Path utilities for consistent path normalization and conversion
 * between local workspace paths and device paths.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePath = normalizePath;
exports.toDevicePath = toDevicePath;
exports.relFromDevice = relFromDevice;
exports.validatePathConversion = validatePathConversion;
exports.isValidDevicePath = isValidDevicePath;
exports.isValidLocalRelPath = isValidLocalRelPath;
exports.debugPathConversion = debugPathConversion;
exports.saveBoardTreeLocally = saveBoardTreeLocally;
exports.loadBoardTreeLocally = loadBoardTreeLocally;
exports.createBoardTreeData = createBoardTreeData;
exports.debugTreeComparison = debugTreeComparison;
exports.generateComparisonReport = generateComparisonReport;
exports.generateReadableComparisonReport = generateReadableComparisonReport;
/**
 * Normalizes a path by removing duplicate slashes and trailing slashes.
 * Preserves the root slash for absolute paths.
 * @param path The path to normalize
 * @returns The normalized path
 */
function normalizePath(path) {
    if (!path || path === '')
        return '';
    // Replace multiple slashes with single slash
    let normalized = path.replace(/\/+/g, '/');
    // Remove trailing slash unless it's the root path
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}
/**
 * Converts a local relative path to an absolute device path.
 * @param localRel Local relative path (e.g., "lib/utils.py")
 * @param rootPath Device root path (e.g., "/", "/code")
 * @returns Absolute device path (e.g., "/lib/utils.py", "/code/lib/utils.py")
 */
function toDevicePath(localRel, rootPath) {
    if (!localRel && !rootPath)
        return '/';
    const normalizedLocal = normalizePath(localRel);
    const normalizedRoot = normalizePath(rootPath);
    // Handle empty local path
    if (!normalizedLocal || normalizedLocal === '') {
        return normalizedRoot || '/';
    }
    // Handle root path cases
    if (!normalizedRoot || normalizedRoot === '' || normalizedRoot === '/') {
        // Root is "/", prepend slash to local path
        return '/' + normalizedLocal.replace(/^\/+/, '');
    }
    // Combine root and local path
    const localWithoutLeadingSlash = normalizedLocal.replace(/^\/+/, '');
    return normalizedRoot + '/' + localWithoutLeadingSlash;
}
/**
 * Converts a device absolute path to a local relative path.
 * @param devicePath Absolute device path (e.g., "/lib/utils.py", "/code/lib/utils.py")
 * @param rootPath Device root path (e.g., "/", "/code")
 * @returns Local relative path (e.g., "lib/utils.py")
 */
function relFromDevice(devicePath, rootPath) {
    if (!devicePath)
        return '';
    const normalizedDevice = normalizePath(devicePath);
    const normalizedRoot = normalizePath(rootPath);
    // Handle root path cases
    if (!normalizedRoot || normalizedRoot === '' || normalizedRoot === '/') {
        // Root is "/", remove leading slash from device path
        return normalizedDevice.replace(/^\/+/, '');
    }
    // If device path equals root path exactly, return empty string
    if (normalizedDevice === normalizedRoot) {
        return '';
    }
    // If device path starts with root path + slash, remove the root prefix
    const rootWithSlash = normalizedRoot + '/';
    if (normalizedDevice.startsWith(rootWithSlash)) {
        return normalizedDevice.slice(rootWithSlash.length);
    }
    // Fallback: remove leading slash if present
    return normalizedDevice.replace(/^\/+/, '');
}
/**
 * Validates that path conversion is bidirectional and consistent.
 * @param localRel Local relative path
 * @param rootPath Device root path
 * @returns True if conversion is consistent, false otherwise
 */
function validatePathConversion(localRel, rootPath) {
    try {
        const devicePath = toDevicePath(localRel, rootPath);
        const backToLocal = relFromDevice(devicePath, rootPath);
        return backToLocal === localRel;
    }
    catch (error) {
        console.error('[PATH_VALIDATION] Error validating path conversion:', error);
        return false;
    }
}
/**
 * Validates that a device path is properly formatted.
 * @param devicePath The device path to validate
 * @returns True if valid, false otherwise
 */
function isValidDevicePath(devicePath) {
    if (!devicePath || typeof devicePath !== 'string')
        return false;
    // Must start with slash (absolute path)
    if (!devicePath.startsWith('/'))
        return false;
    // No double slashes (except at start)
    if (devicePath.includes('//'))
        return false;
    // No trailing slash unless it's root
    if (devicePath.length > 1 && devicePath.endsWith('/'))
        return false;
    return true;
}
/**
 * Validates that a local relative path is properly formatted.
 * @param localRel The local relative path to validate
 * @returns True if valid, false otherwise
 */
function isValidLocalRelPath(localRel) {
    if (localRel === '' || localRel === null || localRel === undefined)
        return true; // Empty is valid
    if (typeof localRel !== 'string')
        return false;
    // Should not start with slash (relative path)
    if (localRel.startsWith('/'))
        return false;
    // No double slashes
    if (localRel.includes('//'))
        return false;
    // No trailing slash
    if (localRel.endsWith('/'))
        return false;
    return true;
}
/**
 * Debug function to log path conversion details.
 * @param localRel Local relative path
 * @param rootPath Device root path
 * @param context Context string for logging
 */
function debugPathConversion(localRel, rootPath, context = '') {
    const devicePath = toDevicePath(localRel, rootPath);
    const backToLocal = relFromDevice(devicePath, rootPath);
    const isValid = validatePathConversion(localRel, rootPath);
    console.log(`[PATH_DEBUG] ${context}`);
    console.log(`  Local: "${localRel}"`);
    console.log(`  Root: "${rootPath}"`);
    console.log(`  Device: "${devicePath}"`);
    console.log(`  Back to Local: "${backToLocal}"`);
    console.log(`  Valid: ${isValid}`);
    if (!isValid) {
        console.warn(`[PATH_DEBUG] ⚠️  Path conversion is not bidirectional!`);
    }
}
/**
 * Save board tree data to local file for debugging and persistence
 * @param wsPath Workspace path
 * @param treeData Board tree data to save
 * @param filename Optional filename (defaults to board-tree.json)
 */
async function saveBoardTreeLocally(wsPath, treeData, filename = 'board-tree.json') {
    const fs = require('fs/promises');
    const path = require('path');
    try {
        const workbenchDir = path.join(wsPath, '.mpy-workbench');
        await fs.mkdir(workbenchDir, { recursive: true });
        const filePath = path.join(workbenchDir, filename);
        await fs.writeFile(filePath, JSON.stringify(treeData, null, 2), 'utf8');
        console.log(`[BOARD_TREE] Saved board tree to: ${filePath}`);
        console.log(`[BOARD_TREE] Files found: ${treeData.files.length}`);
        console.log(`[BOARD_TREE] Root path: ${treeData.rootPath}`);
        console.log(`[BOARD_TREE] Timestamp: ${new Date(treeData.timestamp).toISOString()}`);
    }
    catch (error) {
        console.error(`[BOARD_TREE] Failed to save board tree:`, error);
        throw error;
    }
}
/**
 * Load board tree data from local file
 * @param wsPath Workspace path
 * @param filename Optional filename (defaults to board-tree.json)
 * @returns Board tree data or null if not found
 */
async function loadBoardTreeLocally(wsPath, filename = 'board-tree.json') {
    const fs = require('fs/promises');
    const path = require('path');
    try {
        const filePath = path.join(wsPath, '.mpy-workbench', filename);
        const data = await fs.readFile(filePath, 'utf8');
        const treeData = JSON.parse(data);
        console.log(`[BOARD_TREE] Loaded board tree from: ${filePath}`);
        console.log(`[BOARD_TREE] Files loaded: ${treeData.files.length}`);
        console.log(`[BOARD_TREE] Age: ${Date.now() - treeData.timestamp}ms`);
        return treeData;
    }
    catch (error) {
        console.log(`[BOARD_TREE] No saved board tree found or failed to load:`, error);
        return null;
    }
}
/**
 * Create board tree data from device stats
 * @param deviceStats Device file statistics
 * @param rootPath Root path used for the scan
 * @param rawTreeOutput Raw tree command output
 * @param parsedLines Parsed tree lines
 * @returns Board tree data structure
 */
function createBoardTreeData(deviceStats, rootPath, rawTreeOutput = '', parsedLines = []) {
    // Add normalized path for each file for direct comparison with local files
    const filesWithNormalizedPaths = deviceStats.map(file => ({
        ...file,
        normalizedPath: relFromDevice(file.path, rootPath)
    }));
    return {
        timestamp: Date.now(),
        rootPath,
        files: filesWithNormalizedPaths,
        rawTreeOutput,
        parsedLines
    };
}
/**
 * Debug function to compare local vs board tree data
 * @param localFiles Local file list
 * @param boardTreeData Board tree data
 * @param rootPath Root path for conversion
 */
function debugTreeComparison(localFiles, boardTreeData, rootPath) {
    console.log(`\n[DEBUG_COMPARISON] === TREE COMPARISON ANALYSIS ===`);
    console.log(`[DEBUG_COMPARISON] Local files: ${localFiles.length}`);
    console.log(`[DEBUG_COMPARISON] Board files: ${boardTreeData.files.length}`);
    console.log(`[DEBUG_COMPARISON] Root path: ${rootPath}`);
    // Use pre-calculated normalized paths from board tree data
    const boardLocalPaths = boardTreeData.files
        .filter(f => !f.isDir)
        .map(f => f.normalizedPath);
    console.log(`\n[DEBUG_COMPARISON] First 10 local files:`);
    localFiles.slice(0, 10).forEach((file, i) => {
        console.log(`  ${i + 1}. ${file}`);
    });
    console.log(`\n[DEBUG_COMPARISON] First 10 board files (using normalized paths):`);
    boardTreeData.files
        .filter(f => !f.isDir)
        .slice(0, 10)
        .forEach((file, i) => {
        console.log(`  ${i + 1}. ${file.normalizedPath} (device: ${file.path})`);
    });
    // Find missing files
    const missingInBoard = localFiles.filter(local => !boardLocalPaths.includes(local));
    const extraInBoard = boardLocalPaths.filter(board => !localFiles.includes(board));
    console.log(`\n[DEBUG_COMPARISON] Missing in board (${missingInBoard.length}):`);
    missingInBoard.slice(0, 10).forEach(file => {
        console.log(`  ❌ ${file}`);
    });
    console.log(`\n[DEBUG_COMPARISON] Extra in board (${extraInBoard.length}):`);
    extraInBoard.slice(0, 10).forEach(file => {
        console.log(`  ➕ ${file}`);
    });
    if (missingInBoard.length > 10) {
        console.log(`  ... and ${missingInBoard.length - 10} more`);
    }
    if (extraInBoard.length > 10) {
        console.log(`  ... and ${extraInBoard.length - 10} more`);
    }
    console.log(`[DEBUG_COMPARISON] ====================================\n`);
}
/**
 * Generate detailed comparison report file
 * @param localFiles Local file list
 * @param boardTreeData Board tree data
 * @param rootPath Root path for conversion
 * @param wsPath Workspace path to save the report
 */
async function generateComparisonReport(localFiles, boardTreeData, rootPath, wsPath) {
    const fs = require('fs/promises');
    const path = require('path');
    try {
        const workbenchDir = path.join(wsPath, '.mpy-workbench');
        await fs.mkdir(workbenchDir, { recursive: true });
        const reportPath = path.join(workbenchDir, 'comparison-report.json');
        // Create detailed comparison data
        const comparisonData = {
            timestamp: new Date().toISOString(),
            rootPath,
            summary: {
                localFilesCount: localFiles.length,
                boardFilesCount: boardTreeData.files.filter(f => !f.isDir).length,
                totalDirectories: boardTreeData.files.filter(f => f.isDir).length
            },
            files: []
        };
        // Convert board files to local relative paths for easy lookup
        const boardFileMap = new Map();
        boardTreeData.files
            .filter(f => !f.isDir)
            .forEach(file => {
            boardFileMap.set(file.normalizedPath, file);
        });
        // Compare local files with board files
        for (const localFile of localFiles) {
            const boardFile = boardFileMap.get(localFile);
            if (boardFile) {
                // File exists on both sides
                comparisonData.files.push({
                    localPath: localFile,
                    boardPath: boardFile.path,
                    status: 'match',
                    boardFile: {
                        path: boardFile.path,
                        size: boardFile.size,
                        mtime: boardFile.mtime,
                        isDir: boardFile.isDir
                    }
                });
            }
            else {
                // File missing on board
                comparisonData.files.push({
                    localPath: localFile,
                    boardPath: null,
                    status: 'missing_on_board',
                    notes: `File exists locally but not found on board`
                });
            }
        }
        // Add files that exist on board but not locally
        for (const [normalizedPath, boardFile] of boardFileMap.entries()) {
            if (!localFiles.includes(normalizedPath)) {
                comparisonData.files.push({
                    localPath: null,
                    boardPath: boardFile.path,
                    status: 'extra_on_board',
                    boardFile: {
                        path: boardFile.path,
                        size: boardFile.size,
                        mtime: boardFile.mtime,
                        isDir: boardFile.isDir
                    },
                    notes: `File exists on board but not found locally`
                });
            }
        }
        // Sort files for better readability
        comparisonData.files.sort((a, b) => {
            const pathA = a.localPath || a.boardPath || '';
            const pathB = b.localPath || b.boardPath || '';
            return pathA.localeCompare(pathB);
        });
        // Save the report
        await fs.writeFile(reportPath, JSON.stringify(comparisonData, null, 2), 'utf8');
        console.log(`[COMPARISON_REPORT] Generated detailed comparison report: ${reportPath}`);
        console.log(`[COMPARISON_REPORT] Total files compared: ${comparisonData.files.length}`);
        console.log(`[COMPARISON_REPORT] Matches: ${comparisonData.files.filter(f => f.status === 'match').length}`);
        console.log(`[COMPARISON_REPORT] Missing on board: ${comparisonData.files.filter(f => f.status === 'missing_on_board').length}`);
        console.log(`[COMPARISON_REPORT] Extra on board: ${comparisonData.files.filter(f => f.status === 'extra_on_board').length}`);
    }
    catch (error) {
        console.error(`[COMPARISON_REPORT] Failed to generate comparison report:`, error);
        throw error;
    }
}
/**
 * Generate human-readable comparison report file
 * @param localFiles Local file list
 * @param boardTreeData Board tree data
 * @param rootPath Root path for conversion
 * @param wsPath Workspace path to save the report
 */
async function generateReadableComparisonReport(localFiles, boardTreeData, rootPath, wsPath) {
    const fs = require('fs/promises');
    const path = require('path');
    try {
        const workbenchDir = path.join(wsPath, '.mpy-workbench');
        await fs.mkdir(workbenchDir, { recursive: true });
        const reportPath = path.join(workbenchDir, 'comparison-report.txt');
        // Create readable report content
        let reportContent = '';
        reportContent += '='.repeat(80) + '\n';
        reportContent += 'MICROPYTHON WORKBENCH - FILE COMPARISON REPORT\n';
        reportContent += '='.repeat(80) + '\n\n';
        reportContent += `Generated: ${new Date().toISOString()}\n`;
        reportContent += `Root Path: ${rootPath}\n\n`;
        // Summary
        const boardFiles = boardTreeData.files.filter(f => !f.isDir);
        const directories = boardTreeData.files.filter(f => f.isDir);
        reportContent += 'SUMMARY:\n';
        reportContent += '-'.repeat(40) + '\n';
        reportContent += `Local files:     ${localFiles.length}\n`;
        reportContent += `Board files:     ${boardFiles.length}\n`;
        reportContent += `Directories:     ${directories.length}\n\n`;
        // Convert board files to local relative paths for easy lookup
        const boardFileMap = new Map();
        boardFiles.forEach(file => {
            boardFileMap.set(file.normalizedPath, file);
        });
        // Compare and categorize files
        const matches = [];
        const missingOnBoard = [];
        const extraOnBoard = [];
        // Check local files
        for (const localFile of localFiles) {
            const boardFile = boardFileMap.get(localFile);
            if (boardFile) {
                matches.push(localFile);
            }
            else {
                missingOnBoard.push(localFile);
            }
        }
        // Check for extra files on board
        for (const [normalizedPath] of boardFileMap.entries()) {
            if (!localFiles.includes(normalizedPath)) {
                extraOnBoard.push(normalizedPath);
            }
        }
        // Files that match
        if (matches.length > 0) {
            reportContent += `MATCHING FILES (${matches.length}):\n`;
            reportContent += '-'.repeat(40) + '\n';
            matches.forEach(file => {
                const boardFile = boardFileMap.get(file);
                reportContent += `✓ ${file}\n`;
                reportContent += `  Local: ${file}\n`;
                reportContent += `  Board: ${boardFile.path}\n`;
                reportContent += `  Size:  ${boardFile.size} bytes\n\n`;
            });
        }
        // Files missing on board
        if (missingOnBoard.length > 0) {
            reportContent += `MISSING ON BOARD (${missingOnBoard.length}):\n`;
            reportContent += '-'.repeat(40) + '\n';
            missingOnBoard.forEach(file => {
                reportContent += `✗ ${file}\n`;
                reportContent += `  Local: ${file}\n`;
                reportContent += `  Board: NOT FOUND\n\n`;
            });
        }
        // Extra files on board
        if (extraOnBoard.length > 0) {
            reportContent += `EXTRA ON BOARD (${extraOnBoard.length}):\n`;
            reportContent += '-'.repeat(40) + '\n';
            extraOnBoard.forEach(file => {
                const boardFile = boardFileMap.get(file);
                reportContent += `➕ ${file}\n`;
                reportContent += `  Local: NOT FOUND\n`;
                reportContent += `  Board: ${boardFile.path}\n`;
                reportContent += `  Size:  ${boardFile.size} bytes\n\n`;
            });
        }
        // Directory listing
        if (directories.length > 0) {
            reportContent += `DIRECTORIES ON BOARD (${directories.length}):\n`;
            reportContent += '-'.repeat(40) + '\n';
            directories.forEach(dir => {
                reportContent += `📁 ${dir.normalizedPath} (${dir.path})\n`;
            });
            reportContent += '\n';
        }
        reportContent += '='.repeat(80) + '\n';
        reportContent += 'End of report\n';
        // Save the readable report
        await fs.writeFile(reportPath, reportContent, 'utf8');
        console.log(`[COMPARISON_REPORT] Generated readable comparison report: ${reportPath}`);
    }
    catch (error) {
        console.error(`[COMPARISON_REPORT] Failed to generate readable comparison report:`, error);
        throw error;
    }
}
//# sourceMappingURL=pathUtils.js.map