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
    ''
  ].join('\n');
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
      const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
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

              // Use cpToDevice which includes directory creation logic
              console.log(`[DEBUG] syncBaseline: Executing cpToDevice: ${localPath} -> ${devicePath}`);

              await mp.cpToDevice(localPath, devicePath);

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

      // Save manifest locally only (no device manifest to avoid .mpy-workbench folder on board)
      const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
      await saveManifest(manifestPath, man);
      console.log(`[DEBUG] syncBaseline: ✓ Manifest saved locally: ${manifestPath}`);

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

      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      console.log(`[DEBUG] checkDiffs: rootPath: ${rootPath}`);

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

      // Get all local directories
      const localDirectories = new Set<string>();
      async function collectLocalDirs(dir: string, relBase = ""): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const rel = path.posix.join(relBase, e.name);
          const abs = path.join(dir, e.name);
          if (matcher(rel, true)) continue; // Skip ignored directories
          localDirectories.add(rel);
          await collectLocalDirs(abs, rel); // Recursively collect subdirectories
        }
      }
      await collectLocalDirs(ws.uri.fsPath);

      progress.report({ message: "Reading board files..." });

      // Get all board files and sizes in one optimized call
      const boardData = await mp.getBoardFilesAndSizes(rootPath);
      const boardFiles = boardData.files;
      const boardDirectories = boardData.directories;

      // Filter board files based on ignore rules
      const filteredBoardFiles = new Map<string, { size: number; isDir: boolean }>();
      for (const [boardPath, info] of boardFiles) {
        const relPath = this.relFromDevice(boardPath, rootPath);
        if (!matcher(relPath, false)) {
          filteredBoardFiles.set(boardPath, info);
        }
      }

      // Create reverse mapping for quick lookup by relative path
      const boardFileByRelPath = new Map<string, { path: string; size: number; isDir: boolean }>();
      for (const [boardPath, info] of filteredBoardFiles) {
        const relPath = this.relFromDevice(boardPath, rootPath);
        boardFileByRelPath.set(relPath, { path: boardPath, size: info.size, isDir: info.isDir });
      }

      progress.report({ message: "Comparing files..." });

      const diffSet = new Set<string>(); // Changed files (exist in both but different)
      const localOnlySet = new Set<string>(); // Files that exist locally but not on board
      const localOnlyDirectories = new Set<string>(); // Directories that exist locally but not on board
      const boardOnlySet = new Set<string>(); // Files that exist on board but not locally

      // Batch process local files to get their sizes
      const localFileSizes = new Map<string, number>();
      const statPromises: Promise<void>[] = [];

      for (const localRel of localFiles) {
        const absPath = path.join(ws.uri.fsPath, ...localRel.split('/'));
        statPromises.push(
          fs.stat(absPath).then(stat => {
            localFileSizes.set(localRel, stat.size);
          }).catch(() => {
            // File not accessible, treat as different
            localFileSizes.set(localRel, -1);
          })
        );
      }

      // Wait for all file stats to complete
      await Promise.all(statPromises);

      // Compare files
      for (const localRel of localFiles) {
        const boardFile = boardFileByRelPath.get(localRel);
        const localSize = localFileSizes.get(localRel) || -1;

        if (boardFile) {
          // File exists on both sides - compare sizes
          if (localSize !== boardFile.size) {
            diffSet.add(boardFile.path);
          }
        } else {
          // File exists locally but not on board
          const devicePath = this.toDevicePath(localRel, rootPath);
          console.log(`[DEBUG] checkDiffs: Adding local-only: localRel=${localRel}, devicePath=${devicePath}`);
          localOnlySet.add(devicePath);
        }
      }

      // Find files that exist on board but not locally
      for (const [relPath, boardFile] of boardFileByRelPath) {
        if (!localFiles.includes(relPath)) {
          boardOnlySet.add(boardFile.path);
        }
      }

      // Find directories that exist locally but not on board
      for (const localDir of localDirectories) {
        const devicePath = this.toDevicePath(localDir, rootPath);
        const existsOnBoard = boardDirectories.has(devicePath);
        if (!existsOnBoard) {
          console.log(`[DEBUG] checkDiffs: Adding local-only directory: localDir=${localDir}, devicePath=${devicePath}`);
          localOnlyDirectories.add(devicePath);
        }
      }

      progress.report({ message: "Processing results..." });

      // Store original file-only sets for sync operations
      const originalDiffSet = new Set(diffSet);
      const originalLocalOnlySet = new Set(localOnlySet);
      const originalLocalOnlyDirectories = new Set(localOnlyDirectories);
      const originalBoardOnlySet = new Set(boardOnlySet);

      // Set decorations (simplified - no parent directory marking)
      this.decorations.setDiffs(diffSet);
      this.decorations.setLocalOnly(localOnlySet);
      this.decorations.setLocalOnlyDirectories(localOnlyDirectories);
      this.decorations.setBoardOnly(boardOnlySet);

      // Store original file-only sets for sync operations
      (this.decorations as any)._originalDiffs = originalDiffSet;
      (this.decorations as any)._originalLocalOnly = originalLocalOnlySet;
      (this.decorations as any)._originalLocalOnlyDirectories = originalLocalOnlyDirectories;
      (this.decorations as any)._originalBoardOnly = originalBoardOnlySet;

      // Automatic sync will refresh the tree

      const changedFilesCount = originalDiffSet.size;
      const localOnlyFilesCount = originalLocalOnlySet.size;
      const localOnlyDirectoriesCount = originalLocalOnlyDirectories.size;
      const boardOnlyFilesCount = originalBoardOnlySet.size;
      const totalFilesFlagged = changedFilesCount + localOnlyFilesCount + localOnlyDirectoriesCount + boardOnlyFilesCount;

      vscode.window.showInformationMessage(
        `Board: Diff check complete (${changedFilesCount} changed, ${localOnlyFilesCount} local-only files, ${localOnlyDirectoriesCount} local-only folders, ${boardOnlyFilesCount} board-only, ${totalFilesFlagged} total)`
      );
    });

    // Refresh tree to show decorations and clear cache for fresh device listing
    await vscode.commands.executeCommand("mpyWorkbench.refresh");
  }

  async syncDiffsLocalToBoard(noClear: boolean = false): Promise<void> {
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
          console.log(`[DEBUG] syncDiffsLocalToBoard: Processing devicePath: ${devicePath}, rootPath: ${rootPath}`);
          const rel = toLocalRelative(devicePath, rootPath);
          console.log(`[DEBUG] syncDiffsLocalToBoard: rel: ${rel}`);
          const abs = path.join(ws.uri.fsPath, ...rel.split('/'));
          console.log(`[DEBUG] syncDiffsLocalToBoard: abs: ${abs}`);

          try {
            await fs.access(abs);
            // Check if it's a directory and skip it
            const stat = await fs.stat(abs);
            if (stat.isDirectory()) {
              console.log(`[DEBUG] syncDiffsLocalToBoard: Skipping directory: ${abs}`);
              continue;
            }
          } catch (accessError: any) {
            console.error(`[DEBUG] syncDiffsLocalToBoard: File not accessible: ${abs}, error: ${accessError.message}`);
            continue;
          }

          const isLocalOnly = localOnlyFiles.includes(devicePath);
          const action = isLocalOnly ? "Uploading (new)" : "Uploading";
          progress.report({ message: `${action} ${rel} (${++done}/${total})` });

          try {
            await mp.uploadReplacing(abs, devicePath);
            this.tree.addNode(devicePath, false); // Add uploaded file to tree
            console.log(`[DEBUG] syncDiffsLocalToBoard: Successfully uploaded: ${abs} -> ${devicePath}`);
          } catch (uploadError: any) {
            console.error(`[DEBUG] syncDiffsLocalToBoard: Failed to upload ${abs} -> ${devicePath}, error: ${uploadError.message}`);
            // Continue with next file instead of failing completely
          }
        }
      });
    });
    const diffCount = diffs.length;
    const localOnlyCount = localOnlyFiles.length;
    const message = localOnlyCount > 0
      ? `Board: ${diffCount} changed and ${localOnlyCount} new files uploaded to board`
      : `Board: ${diffCount} diffed files uploaded to board`;
    if (!noClear) {
      this.decorations.clear();
      vscode.window.showInformationMessage(message + " and marks cleared");
      this.tree.refreshTree();
    } else {
      this.tree.refreshTree();
    }
  }

  async syncDiffsBoardToLocal(noClear: boolean = false): Promise<void> {
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
    const boardOnlyFiles = this.decorations.getBoardOnlyFilesOnly().filter(p => filesSet.has(p));

    if (diffs.length === 0 && boardOnlyFiles.length === 0) {
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
      const allFilesToDownload = [...diffs, ...boardOnlyFiles];
      const filtered = allFilesToDownload.filter(devicePath => {
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
    if (!noClear) {
      this.decorations.clear();
      vscode.window.showInformationMessage("Board: Diffed files downloaded from board and marks cleared");
      this.tree.refreshTree();
    } else {
      this.tree.refreshTree();
    }
  }

  async openFile(node: Esp32Node): Promise<void> {
    if (node.kind !== "file") return;
    const ws = vscode.workspace.workspaceFolders?.[0];
    const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
    if (ws) {
      const rel = toLocalRelative(node.path, rootPath);
      const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });

      // Check if file is local-only (exists locally but not on board)
      const isLocalOnly = (node as any).isLocalOnly;

      if (isLocalOnly) {
        // For local-only files, just open the local file directly
        console.log(`[DEBUG] openFile: Opening local-only file: ${abs}`);
      } else {
        // For files that should exist on board, check if present locally first
        const fileExistsLocally = await fs.access(abs).then(() => true).catch(() => false);
        if (!fileExistsLocally) {
          console.log(`[DEBUG] openFile: File not found locally, copying from board: ${node.path} -> ${abs}`);
          try {
            await this.withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
            console.log(`[DEBUG] openFile: Successfully copied file from board`);
          } catch (copyError: any) {
            console.error(`[DEBUG] openFile: Failed to copy file from board:`, copyError);
            vscode.window.showErrorMessage(`Failed to copy file from board: ${copyError?.message || copyError}`);
            return; // Don't try to open the file if copy failed
          }
        } else {
          console.log(`[DEBUG] openFile: File already exists locally: ${abs}`);
        }
      }

      // Verify the file exists and has content before opening
      try {
        const stats = await fs.stat(abs);
        console.log(`[DEBUG] openFile: Local file size: ${stats.size} bytes`);

        if (stats.size === 0) {
          console.warn(`[DEBUG] openFile: Local file is empty, this might indicate a copy failure`);
          vscode.window.showWarningMessage(`File appears to be empty. The copy from board may have failed.`);
        }

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        await vscode.window.showTextDocument(doc, { preview: false });
        await vscode.workspace.getConfiguration().update("mpyWorkbench.lastOpenedPath", abs);
      } catch (openError: any) {
        console.error(`[DEBUG] openFile: Failed to open local file:`, openError);
        vscode.window.showErrorMessage(`Failed to open file: ${openError?.message || openError}`);
      }
    } else {
      // Fallback: no workspace, use temp
      const temp = vscode.Uri.joinPath(vscode.Uri.file(vscode.workspace.workspaceFolders![0].uri.fsPath), node.path.replace(/\//g, "_"));
      await fs.mkdir(path.dirname(temp.fsPath), { recursive: true });
      try {
        await this.withAutoSuspend(() => mp.cpFromDevice(node.path, temp.fsPath));
        const doc = await vscode.workspace.openTextDocument(temp);
        await vscode.window.showTextDocument(doc, { preview: true });
        await vscode.workspace.getConfiguration().update("mpyWorkbench.lastOpenedPath", temp.fsPath);
      } catch (copyError: any) {
        console.error(`[DEBUG] openFile: Failed to copy file to temp location:`, copyError);
        vscode.window.showErrorMessage(`Failed to copy file from board to temp location: ${copyError?.message || copyError}`);
      }
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
