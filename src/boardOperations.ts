import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { exec, execSync } from "node:child_process";
import { Esp32Node } from "./types";
import * as mp from "./mpremote";
import { buildManifest, diffManifests, saveManifest, loadManifest, createIgnoreMatcher, Manifest } from "./sync";
import { Esp32DecorationProvider } from "./decorations";
import { listDirPyRaw } from "./pyraw";

// Helper to get workspace folder or throw error
function getWorkspaceFolder(): vscode.WorkspaceFolder {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error("No workspace folder open");
  return ws;
}

// Helper to validate if the local folder is initialized
async function isLocalSyncInitialized(): Promise<boolean> {
  try {
    const ws = getWorkspaceFolder();
    const manifestPath = path.join(ws.uri.fsPath, '.mpy-workbench', 'esp32sync.json');
    await fs.access(manifestPath);
    return true;
  } catch {
    return false;
  }
}

// Helper for delays in retry logic
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Workspace-level config and manifest stored in .mpy-workbench/
const MPY_WORKBENCH_DIR = '.mpy-workbench';
const MPY_MANIFEST_FILE = 'esp32sync.json';

async function ensureMpyWorkbenchDir(wsPath: string) {
  try {
    await fs.mkdir(path.join(wsPath, MPY_WORKBENCH_DIR), { recursive: true });
  } catch { /* ignore */ }
}

async function ensureWorkbenchIgnoreFile(wsPath: string) {
  try {
    await ensureMpyWorkbenchDir(wsPath);
    const p = path.join(wsPath, MPY_WORKBENCH_DIR, '.mpyignore');
    await fs.access(p);
  } catch {
    const content = buildDefaultMpyIgnoreContent();
    try { await fs.writeFile(path.join(wsPath, MPY_WORKBENCH_DIR, '.mpyignore'), content, 'utf8'); } catch {}
  }
}

function buildDefaultMpyIgnoreContent(): string {
  return [
    '# .mpyignore — default rules (similar to .gitignore). Adjust according to your project.',
    '# Paths are relative to the workspace root.',
    '',
    '# VCS',
    '.git/',
    '.svn/',
    '.hg/',
    '',
    '# IDE/Editor',
    '.vscode/',
    '.idea/',
    '.vs/',
    '',
    '# SO',
    '.DS_Store',
    'Thumbs.db',
    '',
    '# Node/JS',
    'node_modules/',
    'dist/',
    'out/',
    'build/',
    '.cache/',
    'coverage/',
    '.next/',
    '.nuxt/',
    '.svelte-kit/',
    '.turbo/',
    '.parcel-cache/',
    '*.log',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
    'pnpm-debug.log*',
    '',
    '# Python',
    '__pycache__/',
    '*.py[cod]',
    '*.pyo',
    '*.pyd',
    '.venv/',
    'venv/',
    '.env',
    '.env.*',
    '.mypy_cache/',
    '.pytest_cache/',
    '.coverage',
    'coverage.xml',
    '*.egg-info/',
    '.tox/',
    '',
    '# Otros',
    '*.swp',
    '*.swo',
    '',
    '# MPY Workbench',
    '.mpy-workbench/',
    '/.mpy-workbench',
    '.mpyignore',
    ''
  ].join('\n');
}

// Ensure a root-level .mpyignore exists with sensible defaults
async function ensureRootIgnoreFile(wsPath: string) {
  const ignorePath = path.join(wsPath, '.mpyignore');
  try {
    // If exists, upgrade only if it's the placeholder header with no rules
    const txt = await fs.readFile(ignorePath, 'utf8');
    const nonComment = txt.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const hasOldHeader = /Ignore patterns for MPY Workbench/.test(txt);
    if (hasOldHeader && nonComment.length === 0) {
      try { await fs.writeFile(ignorePath, buildDefaultMpyIgnoreContent(), 'utf8'); } catch {}
    }
    return; // file exists; keep user rules otherwise
  } catch {
    // Not exists: create with defaults
    try { await fs.writeFile(ignorePath, buildDefaultMpyIgnoreContent(), 'utf8'); } catch {}
  }
}

function toLocalRelative(devicePath: string, rootPath: string): string {
  const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
  if (normRoot === "/") return devicePath.replace(/^\//, "");
  if (devicePath.startsWith(normRoot + "/")) return devicePath.slice(normRoot.length + 1);
  if (devicePath === normRoot) return "";
  // Fallback: strip leading slash
  return devicePath.replace(/^\//, "");
}

// Board operations that communicate directly with the device
export class BoardOperations {
  private tree: any;
  private decorations: Esp32DecorationProvider;

  constructor(tree: any, decorations: Esp32DecorationProvider) {
    this.tree = tree;
    this.decorations = decorations;
  }

  // Helper function for auto-suspend operations
  private async withAutoSuspend<T>(fn: () => Promise<T>, opts: { preempt?: boolean } = {}): Promise<T> {
    const enabled = vscode.workspace.getConfiguration().get<boolean>("mpyWorkbench.serialAutoSuspend", true);
    // If auto-suspend disabled, run without suspend logic
    if (!enabled) {
      try { return await fn(); }
      finally { }
    }

    // For now, just execute the function (auto-suspend logic would be implemented here)
    return await fn();
  }

  async syncBaseline(): Promise<void> {
    try {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      const initialized = await isLocalSyncInitialized();
      if (!initialized) {
        const initialize = await vscode.window.showWarningMessage(
          "The local folder is not initialized for synchronization. Would you like to initialize it now?",
          { modal: true },
          "Initialize"
        );
        if (initialize !== "Initialize") return;
        // Create initial manifest to initialize sync
        await ensureRootIgnoreFile(ws.uri.fsPath);
        await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const initialManifest = await buildManifest(ws.uri.fsPath, matcher);
        const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
        await saveManifest(manifestPath, initialManifest);
        vscode.window.showInformationMessage("Local folder initialized for synchronization.");
      }

      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const matcher2 = await createIgnoreMatcher(ws.uri.fsPath);
      const man = await buildManifest(ws.uri.fsPath, matcher2);

      // Upload all files with progress using single mpremote fs cp command
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Uploading all files to board...",
        cancellable: false
      }, async (progress, token) => {
        const files = Object.keys(man.files);
        const total = files.length;

        if (total === 0) {
          progress.report({ increment: 100, message: "No files to upload" });
          return;
        }

        progress.report({ increment: 0, message: `Found ${total} files to upload` });

        await this.withAutoSuspend(async () => {
          // First, create all necessary directories on the device in hierarchical order
          progress.report({ increment: 5, message: "Creating directories on device..." });

          // Collect all unique directory paths that need to be created
          const allDirectories = new Set<string>();
          for (const relativePath of files) {
            const devicePath = path.posix.join(rootPath, relativePath);
            const deviceDir = path.posix.dirname(devicePath);

            if (deviceDir !== '.' && deviceDir !== rootPath) {
              // Add all parent directories to the set
              let currentDir = deviceDir;
              while (currentDir !== rootPath && currentDir !== '/') {
                allDirectories.add(currentDir);
                currentDir = path.posix.dirname(currentDir);
              }
            }
          }

          // Sort directories by depth (shallowest first) to ensure parent directories are created before children
          const sortedDirectories = Array.from(allDirectories).sort((a, b) => {
            const depthA = a.split('/').filter(p => p).length;
            const depthB = b.split('/').filter(p => p).length;
            return depthA - depthB;
          });

          console.log(`[DEBUG] syncBaseline: Need to create ${sortedDirectories.length} directories:`, sortedDirectories);

          // Create directories in hierarchical order with retry logic
          let createdCount = 0;
          let failedDirectories: string[] = [];

          console.log(`[DEBUG] syncBaseline: Starting directory creation for ${sortedDirectories.length} directories...`);

          for (const deviceDir of sortedDirectories) {
            let created = false;
            let attempts = 0;
            const maxAttempts = 3;

            while (!created && attempts < maxAttempts) {
              attempts++;
              try {
                console.log(`[DEBUG] syncBaseline: Creating directory ${deviceDir} (attempt ${attempts}/${maxAttempts})`);
                await mp.mkdir(deviceDir);
                this.tree.addNode(deviceDir, true); // Add folder to tree
                created = true;
                createdCount++;
                console.log(`[DEBUG] syncBaseline: ✓ Created directory ${deviceDir} (${createdCount}/${sortedDirectories.length})`);
              } catch (error: any) {
                console.log(`[DEBUG] syncBaseline: ✗ Directory ${deviceDir} creation failed (attempt ${attempts}):`, error.message);

                if (attempts >= maxAttempts) {
                  failedDirectories.push(deviceDir);
                  console.error(`[DEBUG] syncBaseline: ✗✗ Giving up on directory ${deviceDir} after ${maxAttempts} attempts`);
                } else {
                  // Wait a bit before retrying
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
              }
            }
          }

          console.log(`[DEBUG] syncBaseline: Directory creation completed. Created ${createdCount} out of ${sortedDirectories.length} directories.`);

          if (failedDirectories.length > 0) {
            console.error(`[DEBUG] syncBaseline: Failed to create ${failedDirectories.length} directories:`, failedDirectories);
          }

          // Verify that ALL directories exist before proceeding with bulk upload
          console.log(`[DEBUG] syncBaseline: Verifying ALL directories exist before bulk upload...`);
          let allDirectoriesExist = true;
          const verificationFailures: string[] = [];

          for (const deviceDir of sortedDirectories) {
            try {
              const exists = await mp.fileExists(deviceDir);
              if (!exists) {
                console.error(`[DEBUG] syncBaseline: ✗ Directory ${deviceDir} does not exist!`);
                verificationFailures.push(deviceDir);
                allDirectoriesExist = false;
              } else {
                console.log(`[DEBUG] syncBaseline: ✓ Directory ${deviceDir} verified`);
              }
            } catch (error: any) {
              console.error(`[DEBUG] syncBaseline: ✗ Error checking directory ${deviceDir}:`, error.message);
              verificationFailures.push(deviceDir);
              allDirectoriesExist = false;
            }
          }

          if (!allDirectoriesExist) {
            console.error(`[DEBUG] syncBaseline: Cannot proceed with bulk upload - ${verificationFailures.length} directories missing:`, verificationFailures);

            // Try to create the missing directories one more time
            console.log(`[DEBUG] syncBaseline: Attempting to create missing directories...`);
            for (const missingDir of verificationFailures) {
              try {
                console.log(`[DEBUG] syncBaseline: Creating missing directory: ${missingDir}`);
                await mp.mkdir(missingDir);
                this.tree.addNode(missingDir, true);
                console.log(`[DEBUG] syncBaseline: ✓ Successfully created missing directory: ${missingDir}`);
              } catch (createError: any) {
                console.error(`[DEBUG] syncBaseline: ✗ Failed to create missing directory ${missingDir}:`, createError.message);
              }
            }

            // Verify again after the retry
            console.log(`[DEBUG] syncBaseline: Re-verifying directories after retry...`);
            let stillMissing = [];
            for (const missingDir of verificationFailures) {
              try {
                const exists = await mp.fileExists(missingDir);
                if (!exists) {
                  stillMissing.push(missingDir);
                }
              } catch (error: any) {
                console.error(`[DEBUG] syncBaseline: Error checking ${missingDir} after retry:`, error.message);
                stillMissing.push(missingDir);
              }
            }

            if (stillMissing.length > 0) {
              console.error(`[DEBUG] syncBaseline: Still missing ${stillMissing.length} directories after retry:`, stillMissing);
              throw new Error(`Missing directories after retry: ${stillMissing.join(', ')}`);
            }

            console.log(`[DEBUG] syncBaseline: ✓ All directories now exist after retry`);
          }

          console.log(`[DEBUG] syncBaseline: ✓ All directories verified - proceeding with bulk upload`);

          progress.report({ increment: 10, message: "Starting bulk upload..." });

          // Use individual cp commands instead of bulk upload
          console.log(`[DEBUG] syncBaseline: Using individual cp commands for upload`);

          // Verify all local files exist before building command
          const validFiles = [];
          const missingFiles = [];
          for (const relativePath of files) {
            const localPath = path.join(ws.uri.fsPath, relativePath);

            try {
              await fs.access(localPath);
              validFiles.push(relativePath);
              console.log(`[DEBUG] syncBaseline: ✓ Local file exists: ${localPath}`);
            } catch (error) {
              console.error(`[DEBUG] syncBaseline: ✗ Local file missing: ${localPath}`);
              missingFiles.push(relativePath);
            }
          }

          console.log(`[DEBUG] syncBaseline: ${validFiles.length}/${files.length} local files are accessible`);

          // Warn user about missing files
          if (missingFiles.length > 0) {
            console.warn(`[DEBUG] syncBaseline: Skipping ${missingFiles.length} missing files:`, missingFiles.slice(0, 5));
            if (missingFiles.length > 5) {
              console.warn(`[DEBUG] syncBaseline: ... and ${missingFiles.length - 5} more`);
            }
            vscode.window.showWarningMessage(
              `Found ${missingFiles.length} files in manifest that don't exist locally. These will be skipped. Consider rebuilding the manifest.`
            );
          }

          // Update total for progress reporting
          const actualTotal = validFiles.length;

          console.log(`[DEBUG] syncBaseline: Starting individual uploads for ${actualTotal} files...`);

          let uploaded = 0;
          let failed = 0;

          for (const relativePath of validFiles) {
            const localPath = path.join(ws.uri.fsPath, relativePath);
            const devicePath = path.posix.join(rootPath, relativePath);

            // Double-check file exists before attempting upload (in case it was deleted during the process)
            try {
              await fs.access(localPath);
            } catch (accessError) {
              console.error(`[DEBUG] syncBaseline: ✗ File no longer exists during individual upload: ${localPath}`);
              failed++;
              continue;
            }

            try {
              console.log(`[DEBUG] syncBaseline: Individual upload ${uploaded + 1}/${actualTotal}: ${localPath} -> ${devicePath}`);

              progress.report({
                increment: (80 / actualTotal),
                message: `Uploading ${relativePath} (${uploaded + 1}/${actualTotal})`
              });

              // Use individual cp command instead of bulk
              const cpArgs = ["connect", "auto", "cp", localPath, `:${devicePath}`];
              console.log(`[DEBUG] syncBaseline: Executing: mpremote ${cpArgs.join(' ')}`);

              await mp.runMpremote(cpArgs, { retryOnFailure: true });

              this.tree.addNode(devicePath, false); // Add file to tree

              uploaded++;
              console.log(`[DEBUG] syncBaseline: ✓ Individual upload ${uploaded}/${actualTotal} successful: ${relativePath}`);

            } catch (individualError: any) {
              failed++;
              console.error(`[DEBUG] syncBaseline: ✗ Individual upload failed for ${relativePath}:`, individualError.message);

              // Continue with next file instead of failing completely
              // This allows partial success even if some files fail
            }
          }

          console.log(`[DEBUG] syncBaseline: Individual uploads completed. ${uploaded} successful, ${failed} failed.`);

          if (failed > 0) {
            console.warn(`[DEBUG] syncBaseline: ${failed} files failed to upload individually`);
          }

          progress.report({ increment: 100, message: "All files uploaded successfully" });
        });
      });

      // Save manifest locally and on device
      const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
      await saveManifest(manifestPath, man);
      const tmp = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, "temp_manifest.json");
      await fs.mkdir(path.dirname(tmp), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(man));
      const deviceManifest = (rootPath === "/" ? "/" : rootPath.replace(/\/$/, "")) + "/.mpy-workbench/esp32sync.json";

      try {
        await this.withAutoSuspend(() => mp.cpToDevice(tmp, deviceManifest));
        console.log(`[DEBUG] syncBaseline: ✓ Manifest uploaded to device: ${deviceManifest}`);
      } catch (manifestError: any) {
        console.error(`[DEBUG] syncBaseline: ✗ Failed to upload manifest to device:`, manifestError.message);
        // Don't fail the entire sync if manifest upload fails
        vscode.window.showWarningMessage(`Manifest upload failed, but file sync completed: ${manifestError.message}`);
      }

      vscode.window.showInformationMessage("Board: Sync all files (Local → Board) completed");
      // Clear any diff/local-only markers after successful sync-all
      this.decorations.clear();
      this.tree.refreshTree();
    } catch (error: any) {
      vscode.window.showErrorMessage(`Upload failed: ${error?.message ?? String(error)}`);
    }
  }

  async syncBaselineFromBoard(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
    const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
    const deviceStats = await this.withAutoSuspend(() => mp.listTreeStats(rootPath));
    const matcher = await createIgnoreMatcher(ws.uri.fsPath);
    const toDownload = deviceStats
      .filter(stat => !stat.isDir)
      .filter(stat => {
        const rel = toLocalRelative(stat.path, rootPath);
        return !matcher(rel, false);
      });
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync all files (Board → Local)", cancellable: false }, async (progress) => {
      let done = 0;
      const total = toDownload.length;
      await this.withAutoSuspend(async () => {
        for (const stat of toDownload) {
          const rel = toLocalRelative(stat.path, rootPath);
          const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
          progress.report({ message: `Downloading ${rel} (${++done}/${total})` });
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await mp.cpFromDevice(stat.path, abs);
          this.tree.addNode(stat.path, false); // Add downloaded file to tree
        }
      });
    });
    vscode.window.showInformationMessage("Board: Sync all files (Board → Local) completed");
    // Clear any diff/local-only markers after successful sync-all
    this.decorations.clear();
    this.tree.refreshTree();
  }

  private async generateComparisonPlan(rootPath: string): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;

    console.log("[DEBUG] checkDiffs: Generating comparison plan file...");

    try {
      // Get local files
      const matcher = await createIgnoreMatcher(ws.uri.fsPath);
      const localManifest = await buildManifest(ws.uri.fsPath, matcher);
      const localFiles = Object.keys(localManifest.files);

      // Get device files
      await mp.refreshFileTreeCache();
      const deviceStats = await mp.listTreeStats(rootPath);
      const deviceFiles = deviceStats.filter(e => !e.isDir);

      // Apply ignore rules to device files
      const deviceFilesFiltered = deviceFiles.filter(f => {
        const rel = this.relFromDevice(f.path, rootPath);
        const shouldIgnore = matcher(rel, false);
        return !shouldIgnore;
      });

      const deviceFileMap = new Map(deviceFilesFiltered.map(f => [this.relFromDevice(f.path, rootPath), f]));

      // Generate comparison plan
      const comparisonPlan = {
        timestamp: new Date().toISOString(),
        workspace: ws.uri.fsPath,
        rootPath: rootPath,
        summary: {
          localFilesCount: localFiles.length,
          deviceFilesCount: deviceFilesFiltered.length,
          totalComparisons: localFiles.length + deviceFilesFiltered.length
        },
        comparisons: [] as any[]
      };

      // Files that exist locally - will be compared
      for (const localRel of localFiles) {
        const deviceFile = deviceFileMap.get(localRel);
        const absLocalPath = path.join(ws.uri.fsPath, ...localRel.split('/'));

        if (deviceFile) {
          // File exists in both places - will be compared
          comparisonPlan.comparisons.push({
            type: "comparison",
            localPath: absLocalPath,
            localRelative: localRel,
            boardPath: deviceFile.path,
            expectedAction: "compare_sizes",
            status: "will_compare"
          });
        } else {
          // File exists locally but not on board
          const devicePath = this.toDevicePath(localRel, rootPath);
          comparisonPlan.comparisons.push({
            type: "local_only",
            localPath: absLocalPath,
            localRelative: localRel,
            boardPath: devicePath,
            expectedAction: "mark_as_local_only",
            status: "will_add_to_local_only"
          });
        }
      }

      // Files that exist on board but not locally
      for (const [rel, deviceFile] of deviceFileMap.entries()) {
        if (!localFiles.includes(rel)) {
          const absLocalPath = path.join(ws.uri.fsPath, ...rel.split('/'));
          comparisonPlan.comparisons.push({
            type: "board_only",
            localPath: absLocalPath,
            localRelative: rel,
            boardPath: deviceFile.path,
            expectedAction: "mark_as_different",
            status: "will_add_to_differences"
          });
        }
      }

      // Save comparison plan to file
      const planFilePath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, 'comparison_plan.json');
      await fs.mkdir(path.dirname(planFilePath), { recursive: true });
      await fs.writeFile(planFilePath, JSON.stringify(comparisonPlan, null, 2), 'utf8');

      console.log(`[DEBUG] checkDiffs: Comparison plan saved to: ${planFilePath}`);
      console.log(`[DEBUG] checkDiffs: Plan includes ${comparisonPlan.comparisons.length} file operations`);

      // Show summary in console
      const compareCount = comparisonPlan.comparisons.filter(c => c.type === "comparison").length;
      const localOnlyCount = comparisonPlan.comparisons.filter(c => c.type === "local_only").length;
      const boardOnlyCount = comparisonPlan.comparisons.filter(c => c.type === "board_only").length;

      console.log(`[DEBUG] checkDiffs: Plan Summary:`);
      console.log(`[DEBUG] checkDiffs: - Files to compare: ${compareCount}`);
      console.log(`[DEBUG] checkDiffs: - Local-only files: ${localOnlyCount}`);
      console.log(`[DEBUG] checkDiffs: - Board-only files: ${boardOnlyCount}`);

    } catch (error: any) {
      console.error(`[DEBUG] checkDiffs: Failed to generate comparison plan: ${error.message}`);
    }
  }

  private relFromDevice(devicePath: string, rootPath: string): string {
    const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
    if (normRoot === "/") return devicePath.replace(/^\//, "");
    if (devicePath.startsWith(normRoot + "/")) return devicePath.slice(normRoot.length + 1);
    if (devicePath === normRoot) return "";
    return devicePath.replace(/^\//, "");
  }

  private toDevicePath(localRel: string, rootPath: string): string {
    const normalizedLocalPath = localRel.replace(/\/+/g, '/').replace(/\/$/, '');
    const normalizedRootPath = rootPath.replace(/\/+/g, '/').replace(/\/$/, '');

    if (normalizedRootPath === "") {
      return "/" + normalizedLocalPath;
    }

    if (normalizedLocalPath === "") {
      return normalizedRootPath;
    }

    return normalizedRootPath + "/" + normalizedLocalPath;
  }

  async checkDiffs(): Promise<void> {
    console.log("[DEBUG] checkDiffs: Starting diff check with tree cache");

    const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");

    // Generate comparison plan file before starting
    await this.generateComparisonPlan(rootPath);

    // Helper to convert local relative path to absolute path on board
    const toDevicePath = (localRel: string) => {
      console.log(`[DEBUG] checkDiffs: Converting local path ${localRel} to device path with rootPath ${rootPath}`);

      // Normalize paths
      const normalizedLocalPath = localRel.replace(/\/+/g, '/').replace(/\/$/, '');
      const normalizedRootPath = rootPath.replace(/\/+/g, '/').replace(/\/$/, '');

      console.log(`[DEBUG] checkDiffs: Normalized paths - local: ${normalizedLocalPath}, root: ${normalizedRootPath}`);

      // If root is just "/", add leading slash to local path
      if (normalizedRootPath === "") {
        const result = "/" + normalizedLocalPath;
        console.log(`[DEBUG] checkDiffs: Root is /, result: ${result}`);
        return result;
      }

      // If local path is empty, return root path
      if (normalizedLocalPath === "") {
        console.log(`[DEBUG] checkDiffs: Local path is empty, result: ${normalizedRootPath}`);
        return normalizedRootPath;
      }

      // Combine root and local path
      const result = normalizedRootPath + "/" + normalizedLocalPath;
      console.log(`[DEBUG] checkDiffs: Combined paths, result: ${result}`);
      return result;
    };

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Checking file differences...",
      cancellable: false
    }, async (progress) => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }

      // Check if workspace is initialized for sync
      const initialized = await isLocalSyncInitialized();
      if (!initialized) {
        const initialize = await vscode.window.showWarningMessage(
          "The local folder is not initialized for synchronization. Would you like to initialize it now?",
          { modal: true },
          "Initialize"
        );
        if (initialize !== "Initialize") return;

        // Create initial manifest to initialize sync
        await ensureRootIgnoreFile(ws.uri.fsPath);
        await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const initialManifest = await buildManifest(ws.uri.fsPath, matcher);
        const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
        await saveManifest(manifestPath, initialManifest);
        vscode.window.showInformationMessage("Local folder initialized for synchronization.");
      }

      progress.report({ message: "Reading local files..." });

      // Apply ignore/filters locally before comparing
      const matcher = await createIgnoreMatcher(ws.uri.fsPath);
      const localManifest = await buildManifest(ws.uri.fsPath, matcher);
      const localFiles = Object.keys(localManifest.files);

      console.log(`[DEBUG] checkDiffs: Found ${localFiles.length} local files`);

      progress.report({ message: "Reading board files from cache..." });

      // Clear cache first to ensure fresh data
      console.log(`[DEBUG] checkDiffs: Clearing file tree cache before reading...`);
      await mp.refreshFileTreeCache();

      // Get device files from cache (much faster!)
      const deviceStats = await mp.listTreeStats(rootPath); // This now uses cache
      const deviceFiles = deviceStats.filter(e => !e.isDir);

      console.log(`[DEBUG] checkDiffs: Found ${deviceFiles.length} device files from cache`);

      // Helper to convert device path to local relative
      const relFromDevice = (devicePath: string) => {
        console.log(`[DEBUG] checkDiffs: Converting device path ${devicePath} with rootPath ${rootPath}`);

        // Normalize paths to ensure consistent comparison
        const normalizedDevicePath = devicePath.replace(/\/+/g, '/').replace(/\/$/, '');
        const normalizedRootPath = rootPath.replace(/\/+/g, '/').replace(/\/$/, '');

        console.log(`[DEBUG] checkDiffs: Normalized paths - device: ${normalizedDevicePath}, root: ${normalizedRootPath}`);

        // If root is just "/", remove leading slash from device path
        if (normalizedRootPath === "") {
          const result = normalizedDevicePath.replace(/^\//, "");
          console.log(`[DEBUG] checkDiffs: Root is /, result: ${result}`);
          return result;
        }

        // If device path starts with root path, remove the root prefix
        if (normalizedDevicePath.startsWith(normalizedRootPath + "/")) {
          const result = normalizedDevicePath.slice(normalizedRootPath.length + 1);
          console.log(`[DEBUG] checkDiffs: Path starts with root, result: ${result}`);
          return result;
        }

        // If device path equals root path, return empty string
        if (normalizedDevicePath === normalizedRootPath) {
          console.log(`[DEBUG] checkDiffs: Path equals root, result: ""`);
          return "";
        }

        // Fallback: remove leading slash if present
        const result = normalizedDevicePath.replace(/^\//, "");
        console.log(`[DEBUG] checkDiffs: Fallback, result: ${result}`);
        return result;
      };

      // Apply ignore rules to device files
      const deviceFilesFiltered = deviceFiles.filter(f => {
        const rel = relFromDevice(f.path);
        const shouldIgnore = matcher(rel, false);
        console.log(`[DEBUG] checkDiffs: Device file ${f.path} -> local relative: ${rel}, ignored: ${shouldIgnore}`);
        return !shouldIgnore;
      });

      console.log(`[DEBUG] checkDiffs: After filtering: ${deviceFilesFiltered.length} device files`);

      const deviceFileMap = new Map(deviceFilesFiltered.map(f => [relFromDevice(f.path), f]));
      const diffSet = new Set<string>();
      const localOnlySet = new Set<string>();

      console.log(`[DEBUG] checkDiffs: Device file map keys:`, Array.from(deviceFileMap.keys()));
      console.log(`[DEBUG] checkDiffs: Local files:`, localFiles);

      // Show detailed comparison summary
      console.log(`[DEBUG] checkDiffs: === COMPARISON SUMMARY ===`);
      console.log(`[DEBUG] checkDiffs: Total local files: ${localFiles.length}`);
      console.log(`[DEBUG] checkDiffs: Total device files: ${deviceFilesFiltered.length}`);
      console.log(`[DEBUG] checkDiffs: Device file paths:`, deviceFilesFiltered.map(f => f.path));
      console.log(`[DEBUG] checkDiffs: Device file keys (converted):`, Array.from(deviceFileMap.keys()));
      console.log(`[DEBUG] checkDiffs: ========================`);

      // Debug: Show first few device files with their converted paths
      console.log(`[DEBUG] checkDiffs: First 10 device files with conversions:`);
      deviceFilesFiltered.slice(0, 10).forEach(f => {
        const rel = relFromDevice(f.path);
        console.log(`[DEBUG] checkDiffs: Device: ${f.path} -> Local: ${rel}`);
      });

      progress.report({ message: "Comparing files..." });

      // Compare local files with device files
      console.log(`[DEBUG] checkDiffs: Starting comparison of ${localFiles.length} local files with ${deviceFilesFiltered.length} device files`);

      for (const localRel of localFiles) {
        const deviceFile = deviceFileMap.get(localRel);
        const abs = path.join(ws.uri.fsPath, ...localRel.split('/'));

        console.log(`[DEBUG] checkDiffs: Comparing local file: ${localRel}`);
        console.log(`[DEBUG] checkDiffs: Looking for device file with key: ${localRel}`);
        console.log(`[DEBUG] checkDiffs: Device file found: ${!!deviceFile}`);

        if (deviceFile) {
          console.log(`[DEBUG] checkDiffs: ✓ MATCH FOUND - Local: ${localRel} -> Device: ${deviceFile.path}`);
        } else {
          console.log(`[DEBUG] checkDiffs: ✗ NO MATCH - Local: ${localRel} not found on device`);
          console.log(`[DEBUG] checkDiffs: Available device keys (first 10):`, Array.from(deviceFileMap.keys()).slice(0, 10));
          console.log(`[DEBUG] checkDiffs: Similar device keys:`, Array.from(deviceFileMap.keys()).filter(k => k.includes(localRel.split('/').pop() || '') || localRel.includes(k.split('/').pop() || '')));
        }

        if (deviceFile) {
          try {
            const st = await fs.stat(abs);

            // Obtener SHA256 checksum del archivo local
            console.log(`[DEBUG] checkDiffs: Calculating SHA256 for local file: ${abs}`);
            const localShaResult = execSync(`shasum -a 256 "${abs}"`, {
              encoding: 'utf8',
              timeout: 10000
            });
            const localShaMatch = localShaResult.trim().match(/^([a-f0-9]{64})\s+/);
            const localSha256 = localShaMatch ? localShaMatch[1] : null;

            // Obtener SHA256 checksum del archivo en el board usando solo fs sha256sum
            console.log(`[DEBUG] checkDiffs: Getting SHA256 from board for: ${deviceFile.path}`);
            let boardSha256 = null;
            try {
              const boardShaResult = execSync(`mpremote connect auto fs sha256sum "${deviceFile.path}"`, {
                encoding: 'utf8',
                timeout: 15000
              });


              // Parsear la salida de mpremote fs sha256sum
              // Formato: "sha256sum :filename\nhash_value"
              const shaLines = boardShaResult.trim().split('\n');
              for (const line of shaLines) {
                if (!line.includes('sha256sum') && line.trim()) {
                  // Esta línea debería contener solo el hash
                  const hashMatch = line.trim().match(/^([a-f0-9]{64})$/);
                  if (hashMatch) {
                    boardSha256 = hashMatch[1];
                    break;
                  }
                }
              }
            } catch (shaError: any) {
              console.log(`[DEBUG] checkDiffs: Could not get SHA256 from board: ${shaError.message}`);
            }

            console.log(`[DEBUG] checkDiffs: COMPARING - Local path: ${abs}, Board path: ${deviceFile.path}`);
            console.log(`[DEBUG] checkDiffs: SHA256 comparison: local=${localSha256}, device=${boardSha256}, same=${localSha256 && boardSha256 ? localSha256 === boardSha256 : 'N/A'}`);

            // Comparar usando SHA256 si está disponible
            let filesAreSame = false;
            if (localSha256 && boardSha256) {
              filesAreSame = localSha256 === boardSha256;
              console.log(`[DEBUG] checkDiffs: RESULT - SHA256 ${filesAreSame ? 'MATCH' : 'MISMATCH'}: ${localRel}`);
            } else {
              // Si no se pueden obtener checksums, marcar como diferentes para forzar sync
              filesAreSame = false;
              console.log(`[DEBUG] checkDiffs: RESULT - CANNOT COMPARE (missing SHA256): ${localRel}`);
            }

            if (!filesAreSame) {
              diffSet.add(deviceFile.path);
              console.log(`[DEBUG] checkDiffs: MARKED FOR SYNC - ${localRel}`);
            } else {
              console.log(`[DEBUG] checkDiffs: FILES IDENTICAL - ${localRel}`);
            }
          } catch (error) {
            // Local file not accessible
            diffSet.add(deviceFile.path);
            console.log(`[DEBUG] checkDiffs: ERROR - Local file not accessible: ${abs}, error: ${error}`);
          }
        } else {
          console.log(`[DEBUG] checkDiffs: MISSING - Local file exists but not on board: ${abs}`);
          // This is where the "exists locally but not on board" error comes from
          const devicePath = this.toDevicePath(localRel, rootPath);
          localOnlySet.add(devicePath);
          console.log(`[DEBUG] checkDiffs: ADDED TO LOCAL-ONLY: ${devicePath}`);
        }
      }

      // Files on board that don't exist locally
      for (const [rel, deviceFile] of deviceFileMap.entries()) {
        if (!localFiles.includes(rel)) {
          diffSet.add(deviceFile.path);
          console.log(`[DEBUG] checkDiffs: BOARD-ONLY - File exists on board but not locally: ${deviceFile.path} (local equivalent would be: ${rel})`);
        }
      }

      progress.report({ message: "Checking local-only files..." });

      // Files that exist locally but not on board
      for (const localRel of localFiles) {
        const deviceFile = deviceFileMap.get(localRel);
        if (!deviceFile) {
          const devicePath = toDevicePath(localRel);
          const absLocalPath = path.join(ws.uri.fsPath, ...localRel.split('/'));
          localOnlySet.add(devicePath);
          console.log(`[DEBUG] checkDiffs: LOCAL-ONLY - File exists locally but not on board: ${absLocalPath} -> ${devicePath}`);
        }
      }

      progress.report({ message: "Processing differences..." });

      // Keep original sets for sync operations (files only)
      const originalDiffSet = new Set(diffSet);
      const originalLocalOnlySet = new Set(localOnlySet);

      // Mark parent dirs for any differing children (for decorations only)
      const parents = new Set<string>();
      for (const p of diffSet) {
        let cur = p;
        while (cur.includes('/')) {
          cur = cur.substring(0, cur.lastIndexOf('/')) || '/';
          parents.add(cur);
          if (cur === '/' || cur === rootPath) break;
        }
      }
      for (const d of parents) diffSet.add(d);

      // Mark parent dirs for local-only files too
      for (const p of localOnlySet) {
        let cur = p;
        while (cur.includes('/')) {
          cur = cur.substring(0, cur.lastIndexOf('/')) || '/';
          parents.add(cur);
          if (cur === '/' || cur === rootPath) break;
        }
      }
      for (const d of parents) localOnlySet.add(d);

      // Set decorations with parent directories included
      this.decorations.setDiffs(diffSet);
      this.decorations.setLocalOnly(localOnlySet);

      // Store original file-only sets for sync operations
      (this.decorations as any)._originalDiffs = originalDiffSet;
      (this.decorations as any)._originalLocalOnly = originalLocalOnlySet;

      // Debug: Log what was found
      console.log("Debug - checkDiffs results:");
      console.log("- diffSet:", Array.from(diffSet));
      console.log("- localOnlySet:", Array.from(localOnlySet));
      console.log("- deviceFiles count:", deviceFiles.length, "(filtered:", deviceFilesFiltered.length, ")");
      console.log("- localManifest files count:", Object.keys(localManifest.files).length);

      // Refresh the tree view to show local-only files
      this.tree.refreshTree();

      const changedFilesCount = (this.decorations as any)._originalDiffs ? (this.decorations as any)._originalDiffs.size : Array.from(diffSet).filter(p => !p.endsWith('/')).length;
      const localOnlyFilesCount = (this.decorations as any)._originalLocalOnly ? (this.decorations as any)._originalLocalOnly.size : Array.from(localOnlySet).filter(p => !p.endsWith('/')).length;
      const totalFilesFlagged = changedFilesCount + localOnlyFilesCount;

      vscode.window.showInformationMessage(
        `Board: Diff check complete (${changedFilesCount} changed, ${localOnlyFilesCount} local-only, ${totalFilesFlagged} total files)`
      );
    });
  }

  async syncDiffsLocalToBoard(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
    const initialized = await isLocalSyncInitialized();
    if (!initialized) {
      const initialize = await vscode.window.showWarningMessage(
        "The local folder is not initialized for synchronization. Would you like to initialize it now?",
        { modal: true },
        "Initialize"
      );
      if (initialize !== "Initialize") return;

      // Create initial manifest to initialize sync
      await ensureRootIgnoreFile(ws.uri.fsPath);
      await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
      const matcher = await createIgnoreMatcher(ws.uri.fsPath);
      const initialManifest = await buildManifest(ws.uri.fsPath, matcher);
      const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
      await saveManifest(manifestPath, initialManifest);
      vscode.window.showInformationMessage("Local folder initialized for synchronization.");
    }
    const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
    // Get current diffs and filter to files by comparing with current device stats
    // Check if differences have been detected first
    const allDiffs = this.decorations.getDiffsFilesOnly();
    const allLocalOnly = this.decorations.getLocalOnlyFilesOnly();
    if (allDiffs.length === 0 && allLocalOnly.length === 0) {
      const runCheck = await vscode.window.showInformationMessage(
        "No file differences detected. You need to check for differences first before syncing.",
        "Check Differences Now"
      );
      if (runCheck === "Check Differences Now") {
        await this.checkDiffs();
        // After checking diffs, try again - check both diffs and local-only files
        const newDiffs = this.decorations.getDiffsFilesOnly();
        const newLocalOnly = this.decorations.getLocalOnlyFilesOnly();
        if (newDiffs.length === 0 && newLocalOnly.length === 0) {
          vscode.window.showInformationMessage("No differences found between local and board files.");
          return;
        }
      } else {
        return;
      }
    }

    const deviceStats = await this.withAutoSuspend(() => mp.listTreeStats(rootPath));
    const filesSet = new Set(deviceStats.filter(e => !e.isDir).map(e => e.path));
    const diffs = this.decorations.getDiffsFilesOnly().filter(p => filesSet.has(p));
    const localOnlyFiles = this.decorations.getLocalOnlyFilesOnly();

    // Debug: Log what sync found
    console.log("Debug - syncDiffsLocalToBoard:");
    console.log("- decorations.getDiffsFilesOnly():", this.decorations.getDiffsFilesOnly());
    console.log("- decorations.getLocalOnlyFilesOnly():", this.decorations.getLocalOnlyFilesOnly());
    console.log("- diffs (filtered):", diffs);
    console.log("- localOnlyFiles:", localOnlyFiles);

    const allFilesToSync = [...diffs, ...localOnlyFiles];
    if (allFilesToSync.length === 0) {
      vscode.window.showInformationMessage("Board: No diffed files to sync");
      return;
    }

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync Files Local → Board", cancellable: false }, async (progress) => {
      let done = 0;
      const total = allFilesToSync.length;
      await this.withAutoSuspend(async () => {
        for (const devicePath of allFilesToSync) {
          const rel = toLocalRelative(devicePath, rootPath);
          const abs = path.join(ws.uri.fsPath, ...rel.split('/'));

          try {
            await fs.access(abs);
            // Check if it's a directory and skip it
            const stat = await fs.stat(abs);
            if (stat.isDirectory()) {
              console.log(`Skipping directory: ${abs}`);
              continue;
            }
          } catch {
            continue;
          }

          const isLocalOnly = localOnlyFiles.includes(devicePath);
          const action = isLocalOnly ? "Uploading (new)" : "Uploading";
          progress.report({ message: `${action} ${rel} (${++done}/${total})` });

          await mp.uploadReplacing(abs, devicePath);
          this.tree.addNode(devicePath, false); // Add uploaded file to tree
        }
      });
    });
    this.decorations.clear();
    this.tree.refreshTree();
    const diffCount = diffs.length;
    const localOnlyCount = localOnlyFiles.length;
    const message = localOnlyCount > 0
      ? `Board: ${diffCount} changed and ${localOnlyCount} new files uploaded to board`
      : `Board: ${diffCount} diffed files uploaded to board`;
    vscode.window.showInformationMessage(message + " and marks cleared");
  }

  async syncDiffsBoardToLocal(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }

    const initialized = await isLocalSyncInitialized();
    if (!initialized) {
      const initialize = await vscode.window.showWarningMessage(
        "The local folder is not initialized for synchronization. Would you like to initialize it now?",
        { modal: true },
        "Initialize"
      );
      if (initialize !== "Initialize") return;

      // Create initial manifest to initialize sync
      await ensureRootIgnoreFile(ws.uri.fsPath);
      await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
      const matcher = await createIgnoreMatcher(ws.uri.fsPath);
      const initialManifest = await buildManifest(ws.uri.fsPath, matcher);
      const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
      await saveManifest(manifestPath, initialManifest);
      vscode.window.showInformationMessage("Local folder initialized for synchronization.");
    }

    const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
    // Get current diffs and filter to files by comparing with current device stats
    const deviceStats = await this.withAutoSuspend(() => mp.listTreeStats(rootPath));
    const filesSet = new Set(deviceStats.filter(e => !e.isDir).map(e => e.path));
    const diffs = this.decorations.getDiffsFilesOnly().filter(p => filesSet.has(p));

    if (diffs.length === 0) {
      const localOnlyFiles = this.decorations.getLocalOnly();
      if (localOnlyFiles.length > 0) {
        const syncLocalToBoard = await vscode.window.showInformationMessage(
          `Board → Local: No board files to download, but you have ${localOnlyFiles.length} local-only files. Use 'Sync Files (Local → Board)' to upload them to the board.`,
          { modal: true },
          "Sync Local → Board"
        );
        if (syncLocalToBoard === "Sync Local → Board") {
          await this.syncDiffsLocalToBoard();
        }
      } else {
        const checkNow = await vscode.window.showWarningMessage(
          "Board: No diffed files found to sync. You need to run 'Check Differences' first to detect changes between board and local files.",
          { modal: true },
          "Check Differences Now"
        );
        if (checkNow === "Check Differences Now") {
          await this.checkDiffs();
        }
      }
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync Diffed Files Board → Local", cancellable: false }, async (progress) => {
      let done = 0;
      const matcher = await createIgnoreMatcher(ws.uri.fsPath);
      const filtered = diffs.filter(devicePath => {
        const rel = toLocalRelative(devicePath, rootPath);
        return !matcher(rel, false);
      });
      const total = filtered.length;
      await this.withAutoSuspend(async () => {
        for (const devicePath of filtered) {
          const rel = toLocalRelative(devicePath, rootPath);
          const abs = path.join(ws.uri.fsPath, ...rel.split('/'));
          progress.report({ message: `Downloading ${rel} (${++done}/${total})` });
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await mp.cpFromDevice(devicePath, abs);
          this.tree.addNode(devicePath, false); // Add downloaded file to tree
        }
      });
    });
    this.decorations.clear();
    vscode.window.showInformationMessage("Board: Diffed files downloaded from board and marks cleared");
    this.tree.refreshTree();
  }

  async openFile(node: Esp32Node): Promise<void> {
    if (node.kind !== "file") return;
    const ws = vscode.workspace.workspaceFolders?.[0];
    const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
    if (ws) {
      const rel = toLocalRelative(node.path, rootPath);
      const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // If not present locally, fetch from device to local path
      try { await fs.access(abs); } catch { await this.withAutoSuspend(() => mp.cpFromDevice(node.path, abs)); }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.workspace.getConfiguration().update("mpyWorkbench.lastOpenedPath", abs);
    } else {
      // Fallback: no workspace, use temp
      const temp = vscode.Uri.joinPath(vscode.Uri.file(vscode.workspace.workspaceFolders![0].uri.fsPath), node.path.replace(/\//g, "_"));
      await fs.mkdir(path.dirname(temp.fsPath), { recursive: true });
      await this.withAutoSuspend(() => mp.cpFromDevice(node.path, temp.fsPath));
      const doc = await vscode.workspace.openTextDocument(temp);
      await vscode.window.showTextDocument(doc, { preview: true });
      await vscode.workspace.getConfiguration().update("mpyWorkbench.lastOpenedPath", temp.fsPath);
    }
  }

  async mkdir(node?: Esp32Node): Promise<void> {
    const base = node?.kind === "dir" ? node.path : (node ? path.posix.dirname(node.path) : "/");
    const name = await vscode.window.showInputBox({ prompt: "New folder name", validateInput: v => v ? undefined : "Required" });
    if (!name) return;
    const target = base === "/" ? `/${name}` : `${base}/${name}`;
    await this.withAutoSuspend(() => mp.mkdir(target));
    this.tree.addNode(target, true);
  }

  async delete(node: Esp32Node): Promise<void> {
    const okBoard = await vscode.window.showWarningMessage(`Delete ${node.path} from board?`, { modal: true }, "Delete");
    if (okBoard !== "Delete") return;

    // Mostrar progreso con animación
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Deleting ${node.path}...`,
      cancellable: false
    }, async (progress, token) => {
      progress.report({ increment: 0, message: "Starting deletion..." });
      try {
        // Fast path: one-shot delete (file or directory)
        const isDir = node.kind === "dir";
        progress.report({ increment: 60, message: isDir ? "Removing directory..." : "Removing file..." });
        await this.withAutoSuspend(() => mp.deleteAny(node.path));
        progress.report({ increment: 100, message: "Deletion complete!" });
        vscode.window.showInformationMessage(`Successfully deleted ${node.path} from board`);
        this.tree.removeNode(node.path);
      } catch (err: any) {
        progress.report({ increment: 100, message: "Deletion failed!" });
        vscode.window.showErrorMessage(`Failed to delete ${node.path} from board: ${err?.message ?? String(err)}`);
      }
    });
  }
}
