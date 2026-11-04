import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './logger';

const execFileAsync = promisify(execFile);

/**
 * Utility for getting the Python interpreter path configured in VS Code
 */
export class PythonInterpreterManager {
    private static cachedInterpreter: string | null = null;
    private static lastCacheTime = 0;
    private static readonly CACHE_DURATION = 30000; // 30 seconds
    private static lastMpremoteNotification = 0;
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

        // Method 0: mpyWorkbench.pythonPath override (user explicitly set; use it first)
        try {
            const mpyOverride = this.getMpyWorkbenchPythonPath(workspaceFolder);
            if (mpyOverride) {
                const validation = await this.validatePythonPath(mpyOverride);
                if (validation.valid) {
                    this.cacheResult(mpyOverride);
                    return mpyOverride;
                }
                if (validation.missingMpremote) {
                    this.showMpremoteInstallationNotification(mpyOverride);
                    this.cacheResult(mpyOverride);
                    return mpyOverride; // respect user's choice
                }
                // Python path invalid (e.g. not found); fall through to other methods
            }
        } catch (error) {
            log.warn('Failed to use mpyWorkbench.pythonPath:', error);
        }

        try {
            // Method 1: Try to get from Python extension API
            pythonPath = await this.getPythonFromExtensionAPI(workspaceFolder);
            if (pythonPath) {
                const validation = await this.validatePythonPath(pythonPath);
                if (validation.valid) {
                    this.cacheResult(pythonPath);
                    return pythonPath;
                } else if (validation.missingMpremote) {
                    // Show mpremote installation notification
                    this.showMpremoteInstallationNotification(pythonPath);
                }
            }
        } catch (error) {
            log.debug('Failed to get Python from extension API:', error);
        }

        try {
            // Method 2: Try to get from VS Code configuration
            pythonPath = this.getPythonFromConfiguration(workspaceFolder);
            if (pythonPath) {
                const validation = await this.validatePythonPath(pythonPath);
                if (validation.valid) {
                    this.cacheResult(pythonPath);
                    return pythonPath;
                } else if (validation.missingMpremote) {
                    // Show mpremote installation notification
                    this.showMpremoteInstallationNotification(pythonPath);
                }
            }
        } catch (error) {
            log.debug('Failed to get Python from configuration:', error);
        }

        // Method 3: Try fallback options
        const fallbacks = this.getFallbackPythonPaths();
        for (const fallback of fallbacks) {
            try {
                const validation = await this.validatePythonPath(fallback);
                if (validation.valid) {
                    this.cacheResult(fallback);
                    return fallback;
                } else if (validation.missingMpremote) {
                    // Show mpremote installation notification for the first valid Python we find
                    this.showMpremoteInstallationNotification(fallback);
                    // Continue looking for a working Python with mpremote
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
            log.debug('Error accessing Python extension API:', error);
            return null;
        }
    }

    /**
     * Get only the mpyWorkbench.pythonPath override (used to prioritize user's explicit choice).
     */
    private static getMpyWorkbenchPythonPath(workspaceFolder?: vscode.WorkspaceFolder): string | null {
        const mpyConfig = vscode.workspace.getConfiguration('mpyWorkbench', workspaceFolder?.uri);
        const mpyPythonPath = mpyConfig.get<string>('pythonPath');
        if (mpyPythonPath && mpyPythonPath.trim()) {
            return mpyPythonPath.trim();
        }
        return null;
    }

    /**
     * Get Python interpreter from VS Code configuration
     */
    private static getPythonFromConfiguration(workspaceFolder?: vscode.WorkspaceFolder): string | null {
        // First check MPY Workbench specific override
        const mpyPythonPath = this.getMpyWorkbenchPythonPath(workspaceFolder);
        if (mpyPythonPath) {
            return mpyPythonPath;
        }

        // Then check Python extension configuration
        const config = vscode.workspace.getConfiguration('python', workspaceFolder?.uri);
        
        // Try different configuration keys
        const configKeys = [
            'defaultInterpreterPath',
            'pythonPath', // Deprecated but still used
        ];

        for (const key of configKeys) {
            // In an untrusted workspace, ignore values coming from the workspace
            // (.vscode/settings.json): they would let a cloned repo choose which
            // executable this extension runs.
            let pythonPath: string | undefined;
            if (vscode.workspace.isTrusted) {
                pythonPath = config.get<string>(key);
            } else {
                const info = config.inspect<string>(key);
                pythonPath = info?.globalValue ?? info?.defaultValue;
            }
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
                'py', // Python launcher; defaults to the newest Python 3
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
    private static async validatePythonPath(pythonPath: string): Promise<{ valid: boolean; missingMpremote: boolean; error?: string }> {
        try {
            // Test if Python executable exists and can run
            await execFileAsync(pythonPath, ['-c', 'import sys; print(sys.version)'], { timeout: 5000 });
        } catch (error: any) {
            return { valid: false, missingMpremote: false, error: error?.message || String(error) };
        }

        try {
            // The extension always runs `<python> -m mpremote`, so check exactly that
            // (not an `mpremote` executable on PATH, which may belong to another Python).
            await execFileAsync(pythonPath, ['-m', 'mpremote', '--version'], { timeout: 10000 });
            return { valid: true, missingMpremote: false };
        } catch (error: any) {
            const errorMessage = `${error?.stderr || ''} ${error?.message || String(error)}`;
            if (/No module named ['"]?mpremote/i.test(errorMessage)) {
                return { valid: false, missingMpremote: true, error: errorMessage };
            }
            return { valid: false, missingMpremote: false, error: errorMessage };
        }
    }

    /**
     * Show notification for missing mpremote
     */
    private static showMpremoteInstallationNotification(pythonPath: string): void {
        // Check cooldown to avoid spamming notifications
        const now = Date.now();
        if (now - this.lastMpremoteNotification < this.NOTIFICATION_COOLDOWN) {
            return; // Too soon since last notification
        }
        this.lastMpremoteNotification = now;

        const isMac = process.platform === 'darwin';
        const isLinux = process.platform === 'linux';
        const pipArgs = ['-m', 'pip', 'install', 'mpremote'];
        const installCommand = `${pythonPath} ${pipArgs.join(' ')}`;
        const alternative = isMac
            ? ' (or with Homebrew: brew install mpremote)'
            : isLinux ? ' (or with apt: sudo apt install python3-mpremote)' : '';

        const message = `MPY Workbench requires the 'mpremote' package to communicate with your MicroPython board.`;

        vscode.window.showWarningMessage(message, 'Install mpremote', 'More information').then(selection => {
            if (selection === 'Install mpremote') {
                // Try to install mpremote automatically
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Installing mpremote...',
                    cancellable: false
                }, async (progress) => {
                    try {
                        progress.report({ increment: 0, message: 'Installing mpremote...' });

                        // Run pip through the interpreter with an argument array (no shell).
                        await new Promise<void>((resolve, reject) => {
                            const installProcess = execFile(pythonPath, pipArgs, { timeout: 300000 });
                            installProcess.on('close', (code: number | null) => {
                                if (code === 0) {
                                    progress.report({ increment: 100, message: 'Installation completed' });
                                    vscode.window.showInformationMessage(
                                        'mpremote was installed successfully. Restart VS Code for the changes to take effect.'
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
                            `Error installing mpremote: ${error.message}. Install manually with: ${installCommand}`
                        );
                    }
                });
            } else if (selection === 'More information') {
                // Open the README or show more detailed instructions
                const moreInfoMessage = `To install mpremote:

1. Open a terminal
2. Run: ${installCommand}${alternative}
3. Restart VS Code

Or visit: https://pypi.org/project/mpremote/`;

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
     * Check mpremote availability and show notification if missing
     * This can be called on extension activation to proactively notify users
     */
    static async checkMpremoteAvailability(): Promise<boolean> {
        try {
            const pythonPath = await this.getPythonPath();
            const validation = await this.validatePythonPath(pythonPath);

            if (!validation.valid && validation.missingMpremote) {
                this.showMpremoteInstallationNotification(pythonPath);
                return false;
            }

            return validation.valid;
        } catch (error) {
            log.warn('Error checking mpremote availability:', error);
            return false;
        }
    }
}

/**
 * Convenience function to get Python path
 */
export async function getPythonPath(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
    return PythonInterpreterManager.getPythonPath(workspaceFolder);
}

/**
 * Clear the Python interpreter cache
 */
export function clearPythonCache(): void {
    PythonInterpreterManager.clearCache();
}

/**
 * Check mpremote availability and show notification if missing
 */
export async function checkMpremoteAvailability(): Promise<boolean> {
    return PythonInterpreterManager.checkMpremoteAvailability();
}