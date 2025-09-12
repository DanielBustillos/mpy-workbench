import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Utility for getting the Python interpreter path configured in VS Code
 */
export class PythonInterpreterManager {
    private static cachedInterpreter: string | null = null;
    private static lastCacheTime = 0;
    private static readonly CACHE_DURATION = 30000; // 30 seconds
    private static lastPyserialNotification = 0;
    private static readonly NOTIFICATION_COOLDOWN = 300000; // 5 minutes

    /**
     * Get the Python interpreter path configured in VS Code
     * @param workspaceFolder Optional workspace folder to get workspace-specific interpreter
     * @returns Promise<string> The Python interpreter path
     */
    static async getPythonPath(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        // Check cache first (with timeout)
        const now = Date.now();
        if (this.cachedInterpreter && (now - this.lastCacheTime) < this.CACHE_DURATION) {
            return this.cachedInterpreter;
        }

        let pythonPath: string | null = null;

        try {
            // Method 1: Try to get from Python extension API
            pythonPath = await this.getPythonFromExtensionAPI(workspaceFolder);
            if (pythonPath) {
                const validation = await this.validatePythonPath(pythonPath);
                if (validation.valid) {
                    this.cacheResult(pythonPath);
                    return pythonPath;
                } else if (validation.missingPyserial) {
                    // Show pyserial installation notification
                    this.showPyserialInstallationNotification(pythonPath);
                }
            }
        } catch (error) {
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
                } else if (validation.missingPyserial) {
                    // Show pyserial installation notification
                    this.showPyserialInstallationNotification(pythonPath);
                }
            }
        } catch (error) {
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
                } else if (validation.missingPyserial) {
                    // Show pyserial installation notification for the first valid Python we find
                    this.showPyserialInstallationNotification(fallback);
                    // Continue looking for a working Python with pyserial
                }
            } catch (error) {
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
    private static async getPythonFromExtensionAPI(workspaceFolder?: vscode.WorkspaceFolder): Promise<string | null> {
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
        } catch (error) {
            console.log('Error accessing Python extension API:', error);
            return null;
        }
    }

    /**
     * Get Python interpreter from VS Code configuration
     */
    private static getPythonFromConfiguration(workspaceFolder?: vscode.WorkspaceFolder): string | null {
        // First check MPY Workbench specific override
        const mpyConfig = vscode.workspace.getConfiguration('mpyWorkbench', workspaceFolder?.uri);
        const mpyPythonPath = mpyConfig.get<string>('pythonPath');
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
            const pythonPath = config.get<string>(key);
            if (pythonPath && pythonPath.trim()) {
                return pythonPath.trim();
            }
        }

        return null;
    }

    /**
     * Get fallback Python paths to try
     */
    private static getFallbackPythonPaths(): string[] {
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
        } else {
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
    private static async validatePythonPath(pythonPath: string): Promise<{ valid: boolean; missingPyserial: boolean; error?: string }> {
        try {
            // Test if Python executable exists and can run
            const { stdout } = await execFileAsync(pythonPath, ['-c', 'import sys; print(sys.version)'], { timeout: 5000 });

            // Check if it has the required serial module
            await execFileAsync(pythonPath, ['-c', 'import serial; from serial.tools import list_ports'], { timeout: 5000 });

            return { valid: true, missingPyserial: false };
        } catch (error: any) {
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
    private static showPyserialInstallationNotification(pythonPath: string): void {
        // Check cooldown to avoid spamming notifications
        const now = Date.now();
        if (now - this.lastPyserialNotification < this.NOTIFICATION_COOLDOWN) {
            return; // Too soon since last notification
        }
        this.lastPyserialNotification = now;

        const isWindows = process.platform === 'win32';
        const isMac = process.platform === 'darwin';

        let installCommand: string;
        let packageManager: string;

        if (isWindows) {
            installCommand = `${pythonPath} -m pip install pyserial`;
            packageManager = 'pip';
        } else if (isMac) {
            installCommand = `${pythonPath} -m pip install pyserial`;
            packageManager = 'pip (o usa Homebrew: brew install pyserial)';
        } else {
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

                        return new Promise<void>((resolve, reject) => {
                            installProcess.on('close', (code: number) => {
                                if (code === 0) {
                                    progress.report({ increment: 100, message: 'Installation completed' });
                                    vscode.window.showInformationMessage(
                                        'pyserial was installed successfully. Restart VS Code for the changes to take effect.'
                                    );
                                    // Clear cache so it will re-validate on next use
                                    this.clearCache();
                                    resolve();
                                } else {
                                    reject(new Error(`Installation failed with code ${code}`));
                                }
                            });

                            installProcess.on('error', (error: any) => {
                                reject(error);
                            });
                        });
                    } catch (error: any) {
                        vscode.window.showErrorMessage(
                            `Error installing pyserial: ${error.message}. Install manually with: ${installCommand}`
                        );
                    }
                });
            } else if (selection === 'More information') {
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
    private static cacheResult(pythonPath: string): void {
        this.cachedInterpreter = pythonPath;
        this.lastCacheTime = Date.now();
    }

    /**
     * Clear the cache (useful when Python configuration changes)
     */
    static clearCache(): void {
        this.cachedInterpreter = null;
        this.lastCacheTime = 0;
    }

    /**
     * Check pyserial availability and show notification if missing
     * This can be called on extension activation to proactively notify users
     */
    static async checkPyserialAvailability(): Promise<boolean> {
        try {
            const pythonPath = await this.getPythonPath();
            const validation = await this.validatePythonPath(pythonPath);

            if (!validation.valid && validation.missingPyserial) {
                this.showPyserialInstallationNotification(pythonPath);
                return false;
            }

            return validation.valid;
        } catch (error) {
            console.log('Error checking pyserial availability:', error);
            return false;
        }
    }

    /**
     * Get Python command for terminal usage (handles special cases like 'py -3')
     */
    static async getPythonCommandForTerminal(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
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

/**
 * Convenience function to get Python path
 */
export async function getPythonPath(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
    return PythonInterpreterManager.getPythonPath(workspaceFolder);
}

/**
 * Convenience function to get Python command for terminal
 */
export async function getPythonCommandForTerminal(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
    return PythonInterpreterManager.getPythonCommandForTerminal(workspaceFolder);
}

/**
 * Clear the Python interpreter cache
 */
export function clearPythonCache(): void {
    PythonInterpreterManager.clearCache();
}

/**
 * Check pyserial availability and show notification if missing
 */
export async function checkPyserialAvailability(): Promise<boolean> {
    return PythonInterpreterManager.checkPyserialAvailability();
}