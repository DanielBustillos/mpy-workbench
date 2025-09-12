"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PythonInterpreterManager = void 0;
exports.getPythonPath = getPythonPath;
exports.getPythonCommandForTerminal = getPythonCommandForTerminal;
exports.clearPythonCache = clearPythonCache;
exports.checkPyserialAvailability = checkPyserialAvailability;
const vscode = require("vscode");
const path = require("node:path");
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
/**
 * Utility for getting the Python interpreter path configured in VS Code
 */
class PythonInterpreterManager {
    /**
     * Get the Python interpreter path configured in VS Code
     * @param workspaceFolder Optional workspace folder to get workspace-specific interpreter
     * @returns Promise<string> The Python interpreter path
     */
    static async getPythonPath(workspaceFolder) {
        // Check cache first (with timeout)
        const now = Date.now();
        if (this.cachedInterpreter && (now - this.lastCacheTime) < this.CACHE_DURATION) {
            return this.cachedInterpreter;
        }
        let pythonPath = null;
        try {
            // Method 1: Try to get from Python extension API
            pythonPath = await this.getPythonFromExtensionAPI(workspaceFolder);
            if (pythonPath) {
                const validation = await this.validatePythonPath(pythonPath);
                if (validation.valid) {
                    this.cacheResult(pythonPath);
                    return pythonPath;
                }
                else if (validation.missingPyserial) {
                    // Show pyserial installation notification
                    this.showPyserialInstallationNotification(pythonPath);
                }
            }
        }
        catch (error) {
            console.log('Failed to get Python from extension API:', error);
        }
        try {
            // Method 2: Try to get from VS Code configuration
            pythonPath = this.getPythonFromConfiguration(workspaceFolder);
            if (pythonPath) {
                const validation = await this.validatePythonPath(pythonPath);
                if (validation.valid) {
                    this.cacheResult(pythonPath);
                    return pythonPath;
                }
                else if (validation.missingPyserial) {
                    // Show pyserial installation notification
                    this.showPyserialInstallationNotification(pythonPath);
                }
            }
        }
        catch (error) {
            console.log('Failed to get Python from configuration:', error);
        }
        // Method 3: Try fallback options
        const fallbacks = this.getFallbackPythonPaths();
        for (const fallback of fallbacks) {
            try {
                const validation = await this.validatePythonPath(fallback);
                if (validation.valid) {
                    this.cacheResult(fallback);
                    return fallback;
                }
                else if (validation.missingPyserial) {
                    // Show pyserial installation notification for the first valid Python we find
                    this.showPyserialInstallationNotification(fallback);
                    // Continue looking for a working Python with pyserial
                }
            }
            catch (error) {
                // Continue to next fallback
            }
        }
        // If all else fails, return python3 as last resort
        const lastResort = 'python3';
        this.cacheResult(lastResort);
        return lastResort;
    }
    /**
     * Try to get Python interpreter from the Python extension API
     */
    static async getPythonFromExtensionAPI(workspaceFolder) {
        try {
            const pythonExtension = vscode.extensions.getExtension('ms-python.python');
            if (!pythonExtension) {
                return null;
            }
            // Ensure the extension is activated
            if (!pythonExtension.isActive) {
                await pythonExtension.activate();
            }
            const pythonApi = pythonExtension.exports;
            if (!pythonApi) {
                return null;
            }
            // Try different API methods based on Python extension version
            if (pythonApi.settings && pythonApi.settings.getExecutionDetails) {
                // Newer Python extension API
                const uri = workspaceFolder?.uri;
                const executionDetails = pythonApi.settings.getExecutionDetails(uri);
                if (executionDetails && executionDetails.execCommand && executionDetails.execCommand.length > 0) {
                    return executionDetails.execCommand[0];
                }
            }
            if (pythonApi.getActiveInterpreter) {
                // Older Python extension API
                const interpreter = await pythonApi.getActiveInterpreter(workspaceFolder?.uri);
                if (interpreter && interpreter.path) {
                    return interpreter.path;
                }
            }
            return null;
        }
        catch (error) {
            console.log('Error accessing Python extension API:', error);
            return null;
        }
    }
    /**
     * Get Python interpreter from VS Code configuration
     */
    static getPythonFromConfiguration(workspaceFolder) {
        // First check MPY Workbench specific override
        const mpyConfig = vscode.workspace.getConfiguration('mpyWorkbench', workspaceFolder?.uri);
        const mpyPythonPath = mpyConfig.get('pythonPath');
        if (mpyPythonPath && mpyPythonPath.trim()) {
            return mpyPythonPath.trim();
        }
        // Then check Python extension configuration
        const config = vscode.workspace.getConfiguration('python', workspaceFolder?.uri);
        // Try different configuration keys
        const configKeys = [
            'defaultInterpreterPath',
            'pythonPath', // Deprecated but still used
        ];
        for (const key of configKeys) {
            const pythonPath = config.get(key);
            if (pythonPath && pythonPath.trim()) {
                return pythonPath.trim();
            }
        }
        return null;
    }
    /**
     * Get fallback Python paths to try
     */
    static getFallbackPythonPaths() {
        const isWindows = process.platform === 'win32';
        if (isWindows) {
            return [
                'python',
                'python3',
                'py -3',
                'py',
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python39', 'python.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
            ];
        }
        else {
            return [
                'python3',
                'python',
                '/usr/bin/python3',
                '/usr/local/bin/python3',
                '/opt/homebrew/bin/python3',
                '/usr/bin/python',
                '/usr/local/bin/python',
            ];
        }
    }
    /**
     * Validate that a Python path is valid and has the required modules
     */
    static async validatePythonPath(pythonPath) {
        try {
            // Test if Python executable exists and can run
            const { stdout } = await execFileAsync(pythonPath, ['-c', 'import sys; print(sys.version)'], { timeout: 5000 });
            // Check if it has the required serial module
            await execFileAsync(pythonPath, ['-c', 'import serial; from serial.tools import list_ports'], { timeout: 5000 });
            return { valid: true, missingPyserial: false };
        }
        catch (error) {
            const errorMessage = error.message || String(error);
            // Check if it's specifically a pyserial import error
            if (errorMessage.includes('No module named') && errorMessage.includes('serial')) {
                return { valid: false, missingPyserial: true, error: errorMessage };
            }
            // Other Python-related errors
            return { valid: false, missingPyserial: false, error: errorMessage };
        }
    }
    /**
     * Show notification for missing pyserial
     */
    static showPyserialInstallationNotification(pythonPath) {
        // Check cooldown to avoid spamming notifications
        const now = Date.now();
        if (now - this.lastPyserialNotification < this.NOTIFICATION_COOLDOWN) {
            return; // Too soon since last notification
        }
        this.lastPyserialNotification = now;
        const isWindows = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        let installCommand;
        let packageManager;
        if (isWindows) {
            installCommand = `${pythonPath} -m pip install pyserial`;
            packageManager = 'pip';
        }
        else if (isMac) {
            installCommand = `${pythonPath} -m pip install pyserial`;
            packageManager = 'pip (o usa Homebrew: brew install pyserial)';
        }
        else {
            // Linux
            installCommand = `${pythonPath} -m pip install pyserial`;
            packageManager = 'pip (o usa apt: sudo apt install python3-serial)';
        }
        const message = `MPY Workbench requires the 'pyserial' package to communicate with your MicroPython board.`;
        vscode.window.showWarningMessage(message, 'Install pyserial', 'More information').then(selection => {
            if (selection === 'Install pyserial') {
                // Try to install pyserial automatically
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Installing pyserial...',
                    cancellable: false
                }, async (progress) => {
                    try {
                        progress.report({ increment: 0, message: 'Installing pyserial...' });
                        // Run the installation command
                        const installProcess = require('child_process').exec(installCommand);
                        return new Promise((resolve, reject) => {
                            installProcess.on('close', (code) => {
                                if (code === 0) {
                                    progress.report({ increment: 100, message: 'Installation completed' });
                                    vscode.window.showInformationMessage('pyserial was installed successfully. Restart VS Code for the changes to take effect.');
                                    // Clear cache so it will re-validate on next use
                                    this.clearCache();
                                    resolve();
                                }
                                else {
                                    reject(new Error(`Installation failed with code ${code}`));
                                }
                            });
                            installProcess.on('error', (error) => {
                                reject(error);
                            });
                        });
                    }
                    catch (error) {
                        vscode.window.showErrorMessage(`Error installing pyserial: ${error.message}. Install manually with: ${installCommand}`);
                    }
                });
            }
            else if (selection === 'More information') {
                // Open the README or show more detailed instructions
                const moreInfoMessage = `To install pyserial:

1. Open a terminal
2. Run: ${installCommand}
3. Restart VS Code

Or visit: https://pypi.org/project/pyserial/`;
                vscode.window.showInformationMessage(moreInfoMessage);
            }
        });
    }
    /**
     * Cache the result for performance
     */
    static cacheResult(pythonPath) {
        this.cachedInterpreter = pythonPath;
        this.lastCacheTime = Date.now();
    }
    /**
     * Clear the cache (useful when Python configuration changes)
     */
    static clearCache() {
        this.cachedInterpreter = null;
        this.lastCacheTime = 0;
    }
    /**
     * Check pyserial availability and show notification if missing
     * This can be called on extension activation to proactively notify users
     */
    static async checkPyserialAvailability() {
        try {
            const pythonPath = await this.getPythonPath();
            const validation = await this.validatePythonPath(pythonPath);
            if (!validation.valid && validation.missingPyserial) {
                this.showPyserialInstallationNotification(pythonPath);
                return false;
            }
            return validation.valid;
        }
        catch (error) {
            console.log('Error checking pyserial availability:', error);
            return false;
        }
    }
    /**
     * Get Python command for terminal usage (handles special cases like 'py -3')
     */
    static async getPythonCommandForTerminal(workspaceFolder) {
        const pythonPath = await this.getPythonPath(workspaceFolder);
        // If it's a complex command like 'py -3', return as-is
        if (pythonPath.includes(' ')) {
            return pythonPath;
        }
        // For simple paths, quote them if they contain spaces
        if (pythonPath.includes(' ') && !pythonPath.startsWith('"') && !pythonPath.startsWith("'")) {
            return `"${pythonPath}"`;
        }
        return pythonPath;
    }
}
exports.PythonInterpreterManager = PythonInterpreterManager;
PythonInterpreterManager.cachedInterpreter = null;
PythonInterpreterManager.lastCacheTime = 0;
PythonInterpreterManager.CACHE_DURATION = 30000; // 30 seconds
PythonInterpreterManager.lastPyserialNotification = 0;
PythonInterpreterManager.NOTIFICATION_COOLDOWN = 300000; // 5 minutes
/**
 * Convenience function to get Python path
 */
async function getPythonPath(workspaceFolder) {
    return PythonInterpreterManager.getPythonPath(workspaceFolder);
}
/**
 * Convenience function to get Python command for terminal
 */
async function getPythonCommandForTerminal(workspaceFolder) {
    return PythonInterpreterManager.getPythonCommandForTerminal(workspaceFolder);
}
/**
 * Clear the Python interpreter cache
 */
function clearPythonCache() {
    PythonInterpreterManager.clearCache();
}
/**
 * Check pyserial availability and show notification if missing
 */
async function checkPyserialAvailability() {
    return PythonInterpreterManager.checkPyserialAvailability();
}
//# sourceMappingURL=pythonInterpreter.js.map