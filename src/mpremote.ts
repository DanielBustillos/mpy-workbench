import { execFile, ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { getPythonPath } from "./pythonInterpreter";
import { log } from "./logger";

function normalizeConnect(c: string): string {
  if (c.startsWith("serial://")) return c.replace(/^serial:\/\//, "");
  if (c.startsWith("serial:/")) return c.replace(/^serial:\//, "");

  // On macOS, add /dev/ prefix if it's missing and looks like a cu.* device
  if (c.startsWith("cu.") && !c.startsWith("/dev/")) {
    const normalized = `/dev/${c}`;
    log.debug(`normalizeConnect: Added /dev/ prefix: ${c} -> ${normalized}`);
    return normalized;
  }

  log.debug(`normalizeConnect: Using as-is: ${c}`);
  return c;
}

let currentChild: ChildProcess | null = null;

// Connection Manager for optimized mpremote connections
class ConnectionManager {
  private activeConnections: Map<string, { lastUsed: number; isHealthy: boolean; operationInProgress: boolean }> = new Map();
  private readonly CONNECTION_TIMEOUT = 30000; // 30 seconds
  private readonly HEALTH_CHECK_INTERVAL = 5000; // 5 seconds
  private healthCheckTimer?: NodeJS.Timeout;

  constructor() {
    this.startHealthChecks();
  }

  // Get or create a connection for a specific port
  getConnection(port: string): { port: string; shouldReuse: boolean } {
    const now = Date.now();
    const existing = this.activeConnections.get(port);

    if (existing && (now - existing.lastUsed) < this.CONNECTION_TIMEOUT && existing.isHealthy) {
      // Update last used time
      existing.lastUsed = now;
      return { port, shouldReuse: true };
    }

    // Create new connection entry
    this.activeConnections.set(port, { lastUsed: now, isHealthy: true, operationInProgress: false });
    return { port, shouldReuse: false };
  }

  // Mark connection as unhealthy (after errors)
  markUnhealthy(port: string): void {
    const connection = this.activeConnections.get(port);
    if (connection) {
      connection.isHealthy = false;
    }
  }

  // Mark connection as healthy (after successful operations)
  markHealthy(port: string): void {
    const connection = this.activeConnections.get(port);
    if (connection) {
      connection.isHealthy = true;
      connection.lastUsed = Date.now();
    }
  }

  // Mark operation as started (to prevent concurrent operations)
  markOperationStarted(port: string): void {
    const connection = this.activeConnections.get(port);
    if (connection) {
      connection.operationInProgress = true;
    }
  }

  // Check if operation is in progress
  isOperationInProgress(port: string): boolean {
    const connection = this.activeConnections.get(port);
    return connection ? connection.operationInProgress : false;
  }

  // Mark operation as completed
  markOperationCompleted(port: string): void {
    const connection = this.activeConnections.get(port);
    if (connection) {
      connection.operationInProgress = false;
    }
  }

  // Clean up old connections
  private cleanup(): void {
    const now = Date.now();
    for (const [port, connection] of this.activeConnections.entries()) {
      if (!connection.operationInProgress && (now - connection.lastUsed) > this.CONNECTION_TIMEOUT) {
        this.activeConnections.delete(port);
      }
    }
  }

  // Start periodic health checks
  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(() => {
      this.cleanup();
    }, this.HEALTH_CHECK_INTERVAL);
  }

  // Stop health checks (cleanup)
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    this.activeConnections.clear();
  }

  // Get connection stats for debugging
  getStats(): { activeConnections: number; totalConnections: number } {
    return {
      activeConnections: this.activeConnections.size,
      totalConnections: this.activeConnections.size
    };
  }
}

// Global connection manager instance
const connectionManager = new ConnectionManager();

/** Single source of truth for mpremote subprocess options. Use UTF-8 so mpremote tree output (├──, └──, │) works on Windows (avoids UnicodeEncodeError: 'charmap'). */
export function getMpremoteExecOptions(overrides?: { cwd?: string }): { encoding: "utf8"; env: NodeJS.ProcessEnv; cwd?: string } {
  return {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    ...overrides
  };
}

/** Maximum time to wait for another operation on the same port before giving up. */
const MAX_PORT_WAIT_MS = 120_000;

export function runMpremote(args: string[], opts: { cwd?: string; retryOnFailure?: boolean } = {}): Promise<{ stdout: string; stderr: string }>{
  return new Promise((resolve, reject) => {
    const maxRetries = opts.retryOnFailure !== false ? 2 : 0;
    let attempt = 0;
    let waitStarted = 0;

    const executeCommand = async () => {
      // Extract port from connect command for connection management
      let port = "";
      const connectIndex = args.indexOf("connect");
      if (connectIndex !== -1 && connectIndex + 1 < args.length) {
        port = args[connectIndex + 1];
        // Check if operation is already in progress on this port
        if (connectionManager.isOperationInProgress(port)) {
          if (waitStarted === 0) waitStarted = Date.now();
          if (Date.now() - waitStarted > MAX_PORT_WAIT_MS) {
            // The previous operation never released the port (e.g. a hung process).
            // Fail instead of polling forever.
            return reject(new Error(`Timed out after ${MAX_PORT_WAIT_MS / 1000}s waiting for another operation on ${port} to finish. Use "Cancel all tasks" and try again.`));
          }
          log.debug(`runMpremote: operation already in progress on port ${port}, queuing...`);
          setTimeout(() => { void executeCommand(); }, 100);
          return;
        }
        waitStarted = 0;
        connectionManager.getConnection(port);
        connectionManager.markHealthy(port);
        connectionManager.markOperationStarted(port);
      }
      attempt++;

      let pythonPath: string;
      try {
        const ws = vscode.workspace.workspaceFolders?.[0];
        pythonPath = await getPythonPath(ws);
      } catch (e: any) {
        if (port) connectionManager.markOperationCompleted(port);
        return reject(new Error(`Failed to resolve Python interpreter: ${String(e?.message || e)}`));
      }

      // execFile + argument array: no shell is involved, so paths, port names and
      // code snippets are passed verbatim on every platform (no quoting/injection issues).
      const execOpts = { ...getMpremoteExecOptions({ cwd: opts.cwd }), maxBuffer: 64 * 1024 * 1024 };
      const child = execFile(pythonPath, ["-m", "mpremote", ...args], execOpts, (err, stdout, stderr) => {
        if (currentChild === child) currentChild = null;

        if (err) {
          const emsg = String(stderr || err?.message || "");
          const errorStr = emsg.toLowerCase();

          // Mark connection as unhealthy on certain errors
          if (port && (errorStr.includes("device not configured") ||
                        errorStr.includes("serial port not found") ||
                        errorStr.includes("connection failed"))) {
            connectionManager.markUnhealthy(port);
          }

          // Mark operation as completed (even on failure)
          if (port) {
            connectionManager.markOperationCompleted(port);
          }

          // Retry on transient errors
          if (attempt <= maxRetries && (
              errorStr.includes("device not configured") ||
              errorStr.includes("connection timeout") ||
              errorStr.includes("serial read failed") ||
              errorStr.includes("failed to access") ||
              errorStr.includes("it may be in use by another program")
          )) {
            log.debug(`mpremote command failed (attempt ${attempt}/${maxRetries + 1}), retrying...`);
            setTimeout(() => { void executeCommand(); }, 500 * attempt); // Exponential backoff
            return;
          }

          return reject(new Error(emsg || "mpremote error"));
        }

        // Mark connection as healthy on success
        if (port) {
          connectionManager.markHealthy(port);
          connectionManager.markOperationCompleted(port);
        }

        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });

      currentChild = child;
    };

    void executeCommand();
  });
}

export async function ls(p: string): Promise<string> {
  try {
    // Get the typed entries and convert to string format
    const entries = await lsTyped(p);
    const filenames = entries.map(entry => entry.name);
    return filenames.join('\n');
  } catch (error) {
    throw error;
  }
}

// Tree node structure for building hierarchical representation
interface TreeNode {
  name: string;
  isDir: boolean;
  children: TreeNode[];
  fullPath: string;
}

// Global cache for the complete file tree
let globalFileTreeCache: TreeNode | null = null;
let lastTreeUpdate: number = 0;
const TREE_CACHE_DURATION = 30000; // 30 seconds

// Populate the global cache with complete file tree
async function populateFileTreeCache(): Promise<void> {
  try {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
    log.debug(`populateFileTreeCache: Fetching complete file tree`);
    const { stdout } = await runMpremote(["connect", connect, "fs", "tree"], { retryOnFailure: true });

    log.debug(`populateFileTreeCache: Raw tree output:\n${stdout}`);

    // Parse into hierarchical structure
    const parsedLines = parseTreeLines(String(stdout || ""));
    log.debug(`populateFileTreeCache: Parsed ${parsedLines.length} lines:`, parsedLines.map(l => `${l.fullPath} (depth: ${l.depth})`));

    // Save parsed paths to file in .mpy-workbench only when workspace is initialized
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const manifestPath = path.join(workspaceFolder.uri.fsPath, '.mpy-workbench', 'esp32sync.json');
        if (fs.existsSync(manifestPath)) {
          const workbenchDir = path.join(workspaceFolder.uri.fsPath, '.mpy-workbench');
          const filePath = path.join(workbenchDir, 'tree-paths.json');
          if (!fs.existsSync(workbenchDir)) {
            fs.mkdirSync(workbenchDir, { recursive: true });
          }
          fs.writeFileSync(filePath, JSON.stringify(parsedLines, null, 2));
          log.debug(`Saved ${parsedLines.length} parsed paths to ${filePath}`);
        }
      }
    } catch (error) {
      log.error(`Failed to save parsed paths:`, error);
    }

    const treeRoot = buildTreeFromParsedLines(parsedLines);
    log.debug(`populateFileTreeCache: Built tree with ${treeRoot.children.length} root children`);

    globalFileTreeCache = treeRoot;
    lastTreeUpdate = Date.now();

    log.debug(`populateFileTreeCache: Cache populated with ${parsedLines.length} items`);
  } catch (error) {
    log.error(`populateFileTreeCache: Failed to populate cache:`, error);
    throw error;
  }
}

// Check if cache needs refresh
function isCacheValid(): boolean {
  if (!globalFileTreeCache) return false;
  const now = Date.now();
  return (now - lastTreeUpdate) < TREE_CACHE_DURATION;
}

// Get entries for a specific path from cache
function getEntriesFromCache(targetPath: string): { name: string; isDir: boolean }[] | null {
  if (!globalFileTreeCache) return null;

  log.debug(`getEntriesFromCache: Looking for ${targetPath} in cache`);
  log.debug(`getEntriesFromCache: Cache has ${globalFileTreeCache.children.length} root children`);

  if (targetPath === "/") {
    const result = globalFileTreeCache.children.map(child => ({
      name: child.name,
      isDir: child.isDir
    }));
    log.debug(`getEntriesFromCache: Found ${result.length} root items:`, result.map(r => `${r.name} (${r.isDir ? 'dir' : 'file'})`));
    return result;
  }

  // Find the target directory node
  const pathParts = targetPath.split("/").filter(p => p);
  log.debug(`getEntriesFromCache: Path parts for ${targetPath}:`, pathParts);

  let currentNode = globalFileTreeCache;
  log.debug(`getEntriesFromCache: Starting from root node`);

  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    log.debug(`getEntriesFromCache: Looking for '${part}' in ${currentNode.children.length} children`);
    log.debug(`getEntriesFromCache: Available children:`, currentNode.children.map(c => c.name));

    const found = currentNode.children.find(child => child.name === part);
    if (!found) {
      log.debug(`getEntriesFromCache: Path ${targetPath} not found in cache - '${part}' not found`);
      log.debug(`getEntriesFromCache: Current node children:`, currentNode.children.map(c => `${c.name} (${c.isDir ? 'dir' : 'file'})`));
      return null;
    }
    currentNode = found;
    log.debug(`getEntriesFromCache: Found '${part}', continuing to next level`);
  }

  const result = currentNode.children.map(child => ({
    name: child.name,
    isDir: child.isDir
  }));

  log.debug(`getEntriesFromCache: Found ${result.length} items for ${targetPath}:`, result.map(r => `${r.name} (${r.isDir ? 'dir' : 'file'})`));
  return result;
}

// Clear the cache (useful when files change)
export function clearFileTreeCache(): void {
  globalFileTreeCache = null;
  lastTreeUpdate = 0;
  log.debug(`clearFileTreeCache: Cache cleared`);
}

// Force refresh the cache
export async function refreshFileTreeCache(): Promise<void> {
  log.debug(`refreshFileTreeCache: Forcing cache refresh`);
  globalFileTreeCache = null;
  lastTreeUpdate = 0;
  await populateFileTreeCache();
}

// Debug function to manually test tree parsing
export async function debugTreeParsing(): Promise<void> {
  try {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
    log.debug(`debugTreeParsing: Testing tree command manually`);

    // Get raw tree output
    const { stdout } = await runMpremote(["connect", connect, "fs", "tree"], { retryOnFailure: true });
    log.debug(`debugTreeParsing: Raw tree output:\n${stdout}`);

    // Parse it
    const parsedLines = parseTreeLines(String(stdout || ""));
    log.debug(`debugTreeParsing: Parsed ${parsedLines.length} lines:`, parsedLines);

    // Build tree
    const treeRoot = buildTreeFromParsedLines(parsedLines);
    log.debug(`debugTreeParsing: Built tree with ${treeRoot.children.length} root children`);

    // Test getting entries for root
    const rootEntries = getEntriesFromCache("/");
    log.debug(`debugTreeParsing: Root entries:`, rootEntries);

    // Test getting entries for first subdirectory if exists
    if (treeRoot.children.length > 0 && treeRoot.children[0].isDir) {
      const subPath = `/${treeRoot.children[0].name}`;
      log.debug(`debugTreeParsing: Testing subpath: ${subPath}`);
      const subEntries = getEntriesFromCache(subPath);
      log.debug(`debugTreeParsing: Sub entries for ${subPath}:`, subEntries);
    }

  } catch (error) {
    log.error(`debugTreeParsing: Error:`, error);
  }
}

// Debug function to check filesystem status and read-only issues
export async function debugFilesystemStatus(): Promise<void> {
  try {
    const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
    log.debug(`debugFilesystemStatus: Checking filesystem status`);

    // Check root filesystem stat
    log.debug(`debugFilesystemStatus: Checking root filesystem stat...`);
    const { stdout: statOutput } = await runMpremote(["connect", connect, "fs", "stat", "/"], { retryOnFailure: false });
    log.debug(`debugFilesystemStatus: Root filesystem stat:\n${statOutput}`);

    // Try to check mount information
    log.debug(`debugFilesystemStatus: Checking mount information...`);
    try {
      const { stdout: mountOutput } = await runMpremote(["connect", connect, "exec", "import os; print(os.listdir('/'))"], { retryOnFailure: false });
      log.debug(`debugFilesystemStatus: Root directory listing:\n${mountOutput}`);
    } catch (mountError) {
      log.error(`debugFilesystemStatus: Could not list root directory:`, mountError);
    }

    // Try to check if we can write to root
    log.debug(`debugFilesystemStatus: Testing write permissions...`);
    try {
      await runMpremote(["connect", connect, "exec", "f = open('test_write.tmp', 'w'); f.write('test'); f.close()"], { retryOnFailure: false });
      log.debug(`debugFilesystemStatus: ✓ Write test to root succeeded`);

      // Clean up test file
      try {
        await runMpremote(["connect", connect, "exec", "import os; os.remove('test_write.tmp')"], { retryOnFailure: false });
        log.debug(`debugFilesystemStatus: ✓ Test file cleanup succeeded`);
      } catch (cleanupError) {
        log.debug(`debugFilesystemStatus: ⚠ Test file cleanup failed:`, cleanupError);
      }
    } catch (writeError) {
      log.error(`debugFilesystemStatus: ✗ Write test to root failed:`, writeError);
    }

    // Try to check if we can write to a subdirectory
    log.debug(`debugFilesystemStatus: Testing write permissions in subdirectory...`);
    try {
      await runMpremote(["connect", connect, "exec", "import os; os.mkdir('test_dir')"], { retryOnFailure: false });
      log.debug(`debugFilesystemStatus: ✓ Directory creation succeeded`);

      await runMpremote(["connect", connect, "exec", "f = open('test_dir/test_write.tmp', 'w'); f.write('test'); f.close()"], { retryOnFailure: false });
      log.debug(`debugFilesystemStatus: ✓ Write test in subdirectory succeeded`);

      // Clean up
      try {
        await runMpremote(["connect", connect, "exec", "import os; os.remove('test_dir/test_write.tmp'); os.rmdir('test_dir')"], { retryOnFailure: false });
        log.debug(`debugFilesystemStatus: ✓ Cleanup succeeded`);
      } catch (cleanupError) {
        log.debug(`debugFilesystemStatus: ⚠ Cleanup failed:`, cleanupError);
      }
    } catch (subdirError) {
      log.error(`debugFilesystemStatus: ✗ Subdirectory write test failed:`, subdirError);
    }

    // Check MicroPython version and build
    log.debug(`debugFilesystemStatus: Checking MicroPython version...`);
    try {
      const { stdout: versionOutput } = await runMpremote(["connect", connect, "exec", "import sys; print('MicroPython version:', sys.version)"], { retryOnFailure: false });
      log.debug(`debugFilesystemStatus: Version info:\n${versionOutput}`);
    } catch (versionError) {
      log.error(`debugFilesystemStatus: Could not get version:`, versionError);
    }

  } catch (error) {
    log.error(`debugFilesystemStatus: Error during filesystem check:`, error);
  }
}

// Get cache statistics for debugging
export function getFileTreeCacheStats(): {
  isValid: boolean;
  age: number;
  itemCount: number;
  lastUpdate: number;
} {
  const isValid = isCacheValid();
  const age = Date.now() - lastTreeUpdate;
  let itemCount = 0;

  if (globalFileTreeCache) {
    // Count all nodes in the tree
    const countNodes = (node: TreeNode): number => {
      let count = 1; // count this node
      for (const child of node.children) {
        count += countNodes(child);
      }
      return count;
    };
    itemCount = countNodes(globalFileTreeCache);
  }

  return {
    isValid,
    age,
    itemCount,
    lastUpdate: lastTreeUpdate
  };
}

// Parse tree output into flat list with full paths
function parseTreeLines(treeOutput: string): Array<{fullPath: string, name: string, isDir: boolean, depth: number}> {
  const lines = treeOutput.split(/\r?\n/).filter(line => line.trim());
  const result: Array<{fullPath: string, name: string, isDir: boolean, depth: number}> = [];
  const dirStack: string[] = [];

  log.debug(`Parsing ${lines.length} tree lines`);

  for (const line of lines) {
    // Skip irrelevant lines
    if (!line.trim() || line.includes('tree') || line === ':/' || line === ':') continue;

    log.debug(`Processing: "${line}"`);

    // Parse the line to get level and name
    const parseResult = parseTreeLine(line);
    if (!parseResult) {
      log.debug(`Could not parse line: "${line}"`);
      continue;
    }

    const { level, name } = parseResult;
    log.debug(`Parsed level: ${level}, name: "${name}"`);

    // Adjust directory stack to match current level
    // Keep only elements up to the current level
    dirStack.splice(level);

    // Build full path
    const fullPath = dirStack.length === 0 ? `/${name}` : `${dirStack[dirStack.length - 1]}/${name}`;
    log.debug(`Built full path: ${fullPath}`);

    // Determine if it's a directory
    const isDir = determineIsDirectory(name, lines, lines.indexOf(line));
    log.debug(`Final determination: ${name} is ${isDir ? 'directory' : 'file'}`);

    result.push({ fullPath, name, isDir, depth: level });

    // Add to directory stack if it's a directory
    if (isDir) {
      dirStack.push(fullPath);
      log.debug(`Added to stack: ${fullPath} (stack: [${dirStack.join(', ')}])`);
    }
  }

  log.debug(`Parsed ${result.length} items:`, result.map(r => `${r.fullPath} (${r.isDir ? 'dir' : 'file'})`));
  return result;
}

// Helper function to parse a single tree line
function parseTreeLine(line: string): { level: number, name: string } | null {
  if (!line.trim()) return null;

  const originalLine = line;
  let level = 0;
  let pos = 0;

  // Analyze character by character from the start
  while (pos < line.length) {
    const remaining = line.substring(pos);

    // Check for specific tree patterns
    if (remaining.startsWith('├──') || remaining.startsWith('└──')) {
      // This is the current item at this level
      const name = remaining.substring(3).trim();
      return { level, name };
    } else if (remaining.startsWith('│   ')) {
      // Continuation of parent level - advance level
      level += 1;
      pos += 4;
    } else if (remaining.startsWith('    ')) {
      // 4 spaces can also indicate level
      level += 1;
      pos += 4;
    } else {
      // If no pattern matches, check for space-based indentation
      const stripped = line.trim();
      if (stripped && stripped !== line) {
        // Count spaces/indentation
        const indent = line.length - stripped.length;
        level = Math.floor(indent / 4); // Typically 4 spaces per level
        return { level, name: stripped };
      }
      break;
    }
  }

  return null;
}

// Helper function to determine if an item is a directory
function determineIsDirectory(name: string, allLines: string[], currentIndex: number): boolean {
  // First, check if it has an extension (likely a file)
  if (name.includes('.')) {
    // Check for common file extensions
    const parts = name.split('.');
    if (parts.length >= 2) {
      const ext = parts[parts.length - 1].toLowerCase();
      const fileExtensions = new Set([
        'py', 'txt', 'log', 'md', 'html', 'css', 'js', 'json',
        'ico', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'csv', 'xml',
        'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf'
      ]);
      if (fileExtensions.has(ext)) {
        return false;
      }
    }
  }

  // Check for special files without extension
  const specialFiles = new Set(['main', 'boot', 'README', 'LICENSE', 'Makefile']);
  if (specialFiles.has(name)) {
    return false;
  }

  // Look ahead in the tree to see if this item has children
  for (let j = currentIndex + 1; j < allLines.length && j < currentIndex + 10; j++) {
    const nextLine = allLines[j].trim();
    if (!nextLine || nextLine.includes('tree') || nextLine === ':') break;

    // Parse the next line
    const nextParse = parseTreeLine(nextLine);
    if (nextParse && nextParse.level > 0) {
      // If next item has higher level, this is a directory
      return true;
    }

    // If we hit an item at the same or lower level, stop looking
    if (nextParse && nextParse.level <= 0) {
      break;
    }
  }

  // If no extension and not a special file, assume it's a directory
  if (!name.includes('.') && name !== 'tree' && name.length > 0 && !name.startsWith('.')) {
    return true;
  }

  return false;
}


// Build tree structure from parsed lines (helper function)
function buildTreeFromParsedLines(parsedLines: Array<{fullPath: string, name: string, isDir: boolean, depth: number}>): TreeNode {
  log.debug(`buildTreeFromParsedLines: Building tree from ${parsedLines.length} parsed lines`);

  const root: TreeNode = {
    name: "",
    isDir: true,
    children: [],
    fullPath: "/"
  };

  const nodeMap = new Map<string, TreeNode>();
  nodeMap.set("/", root);

  for (const item of parsedLines) {
    log.debug(`buildTreeFromParsedLines: Processing ${item.fullPath} (depth: ${item.depth})`);

    const pathParts = item.fullPath.split('/').filter(p => p);
    const parentPath = pathParts.length > 1 ? '/' + pathParts.slice(0, -1).join('/') : '/';

    log.debug(`buildTreeFromParsedLines: Path parts: [${pathParts.join(', ')}], parent: ${parentPath}`);

    const parentNode = nodeMap.get(parentPath);

    if (parentNode) {
      log.debug(`buildTreeFromParsedLines: Found parent ${parentPath}, adding ${item.name}`);

      const newNode: TreeNode = {
        name: item.name,
        isDir: item.isDir,
        children: [],
        fullPath: item.fullPath
      };

      parentNode.children.push(newNode);

      if (item.isDir) {
        nodeMap.set(item.fullPath, newNode);
        log.debug(`buildTreeFromParsedLines: Added directory ${item.fullPath} to nodeMap`);
      }

      log.debug(`buildTreeFromParsedLines: Added ${item.name} to ${parentPath}`);
    } else {
      log.debug(`buildTreeFromParsedLines: Parent ${parentPath} not found for ${item.fullPath}`);
    }
  }

  log.debug(`buildTreeFromParsedLines: Final tree structure:`);
  const printTree = (node: TreeNode, indent = 0) => {
    const prefix = '  '.repeat(indent);
    log.debug(`${prefix}${node.name || '/'} (${node.isDir ? 'dir' : 'file'}) - ${node.children.length} children`);
    for (const child of node.children) {
      printTree(child, indent + 1);
    }
  };
  printTree(root);

  return root;
}

// Helper function to parse tree output and extract entries for a specific path
function parseTreeForPath(treeOutput: string, targetPath: string): { name: string; isDir: boolean }[] {
  log.debug(`parseTreeForPath: Parsing tree for path ${targetPath}`);

  try {
    // Parse tree into flat list with full paths
    const parsedLines = parseTreeLines(treeOutput);

    // Filter items that belong to the target path
    log.debug(`Filtering ${parsedLines.length} parsed lines for target path: ${targetPath}`);
    log.debug(`All parsed items:`, parsedLines.map(item => `${item.fullPath} (depth: ${item.depth})`));

    const targetItems = parsedLines.filter(item => {
      log.debug(`Checking item: ${item.fullPath} (depth: ${item.depth})`);

      if (targetPath === "/") {
        // For root, get only items at depth 0 (direct children of root)
        const matches = item.depth === 0;
        log.debug(`Root filter: ${item.fullPath} depth ${item.depth} -> ${matches ? 'KEEP' : 'FILTER OUT'}`);
        return matches;
      } else {
        // For subdirectories, get direct children of the target path
        const targetPathParts = targetPath.split('/').filter(p => p);
        const itemPathParts = item.fullPath.split('/').filter(p => p);

        log.debug(`Subdir filter: target parts: [${targetPathParts.join(', ')}], item parts: [${itemPathParts.join(', ')}]`);

        // Must be exactly one level deeper than target
        if (itemPathParts.length !== targetPathParts.length + 1) {
          log.debug(`Wrong depth: expected ${targetPathParts.length + 1}, got ${itemPathParts.length} -> FILTER OUT`);
          return false;
        }

        // Must start with the same path parts as target
        for (let i = 0; i < targetPathParts.length; i++) {
          if (itemPathParts[i] !== targetPathParts[i]) {
            log.debug(`Path mismatch at position ${i}: expected ${targetPathParts[i]}, got ${itemPathParts[i]} -> FILTER OUT`);
            return false;
          }
        }

        log.debug(`Subdir filter passed for: ${item.fullPath} -> KEEP`);
        return true;
      }
    });

    const result = targetItems.map(item => ({
      name: item.name,
      isDir: item.isDir
    }));

    log.debug(`parseTreeForPath: Found ${targetItems.length} items for ${targetPath}:`, targetItems.map(i => `${i.fullPath} (depth: ${i.depth})`));
    log.debug(`parseTreeForPath: Returning ${result.length} entries:`, result.map(r => `${r.name} (${r.isDir ? 'dir' : 'file'})`));
    return result;
  } catch (error) {
    log.error(`parseTreeForPath: Error parsing tree:`, error);
    return [];
  }
}

export async function lsTyped(p: string): Promise<{ name: string; isDir: boolean }[]> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  log.debug(`lsTyped: Getting entries for path ${p}`);

  try {
    // Check if cache needs to be populated or refreshed
    if (!isCacheValid()) {
      log.debug(`lsTyped: Cache invalid, populating...`);
      await populateFileTreeCache();
    } else {
      log.debug(`lsTyped: Using cached tree data`);
    }

    // Try to get entries from cache first
    const cachedResult = getEntriesFromCache(p);
    if (cachedResult && cachedResult.length > 0) {
      log.debug(`lsTyped: Found ${cachedResult.length} entries in cache for ${p}`);
      return cachedResult;
    }

    log.debug(`lsTyped: No cached results for ${p}, trying direct tree parsing`);

    // Fallback: direct tree parsing for this specific path
    const { stdout } = await runMpremote(["connect", connect, "fs", "tree"], { retryOnFailure: true });
    const result = parseTreeForPath(String(stdout || ""), p);

    log.debug(`lsTyped: Direct parsing found ${result.length} entries for ${p}`);

    // If still no results, try fs ls as last resort
    if (result.length === 0) {
      log.debug(`lsTyped: No results from tree parsing, trying fs ls fallback`);
      try {
        const pathArg = p && p !== "/" ? p : "";
        const args = ["connect", connect, "fs", "ls"].concat(pathArg ? [pathArg] : []);

        const { stdout: lsOutput } = await runMpremote(args, { retryOnFailure: true });
        log.debug(`lsTyped: Fallback ls output:\n${lsOutput}`);

        // Parse ls output as fallback
        const lines = String(lsOutput || "").split(/\r?\n/).filter(line => line.trim());
        const fallbackResult: { name: string; isDir: boolean }[] = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.includes('ls')) continue;

          const parts = trimmed.split(/\s+/).filter(part => part.length > 0);
          if (parts.length >= 2) {
            const size = parseInt(parts[0]) || 0;
            const filename = parts.slice(1).join(' ');

            if (filename) {
              const isDir = size === 0 && filename.endsWith('/');
              const cleanName = filename.replace(/\/$/, '');

              fallbackResult.push({
                name: cleanName,
                isDir
              });
            }
          }
        }

        log.debug(`lsTyped: Fallback parsed ${fallbackResult.length} entries:`, fallbackResult);
        return fallbackResult;
      } catch (fallbackError) {
        log.error(`lsTyped: Fallback also failed:`, fallbackError);
      }
    }

    return result;
  } catch (error) {
    log.error(`lsTyped: Error for path ${p}: ${error}`);
    throw error;
  }
}

export async function listSerialPorts(): Promise<{port: string, name: string}[]> {
  try {
    const { stdout } = await runMpremote(["connect", "list"]);
    const lines = String(stdout||"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);

    // Parse the output format: port serial vid:pid manufacturer device_name
    const devices = lines.map(line => {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const port = parts[0];
        // Device name is everything after vid:pid (manufacturer + device)
        const deviceName = parts.length >= 4 ? parts.slice(3).join(' ') : '';
        // Include all valid ports, but clean up the device name
        if (port && !port.includes('None')) {
          // If device name contains None, use generic description
          const cleanName = deviceName && !deviceName.includes('None') ? deviceName : 'Serial Port';
          return { port, name: cleanName };
        }
      }
      return null;
    }).filter(Boolean) as {port: string, name: string}[];

    if (devices.length === 0) {
      vscode.window.showWarningMessage("No ESP32 devices detected. Make sure mpremote is installed and available in PATH.");
    }
    return devices;
  } catch (err: any) {
    vscode.window.showWarningMessage("Error executing mpremote to detect ports: " + (err?.message || err));
    return [];
  }
}

export async function mkdir(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  try {
    const pathArg = p && p !== "/" ? p : "/";
    await runMpremote(["connect", connect, "fs", "mkdir", pathArg], { retryOnFailure: true });

    // Invalidate cache since filesystem changed
    clearFileTreeCache();
  } catch (error) {
    // Mark connection as unhealthy
    connectionManager.markUnhealthy(connect);
    throw error;
  }
}

export async function cpFromDevice(devicePath: string, localPath: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  try {
    // Strip leading slash from device paths for mpremote compatibility
    // mpremote expects root-level files without leading slash (test_write.tmp vs /test_write.tmp)
    const deviceArg = devicePath && devicePath !== "/" ? devicePath.replace(/^\//, "") : "/";
    // For cp FROM device TO local, device path needs : prefix
    const devicePathWithPrefix = deviceArg === "/" ? ":" : `:${deviceArg}`;
    const commandArgs = ["connect", connect, "fs", "cp", devicePathWithPrefix, localPath];
    const command = `mpremote ${commandArgs.map(arg => `"${arg}"`).join(' ')}`;

    log.debug(`cpFromDevice: Executing command: ${command}`);
    log.debug(`cpFromDevice: Device path: ${devicePath} -> ${deviceArg} -> ${devicePathWithPrefix}`);
    await runMpremote(commandArgs, { retryOnFailure: true });

    // Note: We don't clear cache here since we're only reading, not modifying
  } catch (error: any) {
    connectionManager.markUnhealthy(connect);
    // Include command and file paths in error message for better debugging
    const deviceArg = devicePath && devicePath !== "/" ? devicePath.replace(/^\//, "") : "/";
    const command = `mpremote connect ${connect} fs cp "${deviceArg}" "${localPath}"`;
    const enhancedError = new Error(`Failed to copy from device: ${error?.message || error}\nCommand: ${command}\nOriginal device path: ${devicePath}\nNormalized device path: ${deviceArg}\nLocal path: ${localPath}`);
    throw enhancedError;
  }
}

export async function cpToDevice(localPath: string, devicePath: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  try {
    // Ensure parent directories exist on device before copying
    const deviceArg = devicePath && devicePath !== "/" ? devicePath : "/";
    const parentDir = deviceArg.substring(0, deviceArg.lastIndexOf('/'));
    
    if (parentDir && parentDir !== "" && parentDir !== "/") {
      log.debug(`cpToDevice: Creating parent directory: ${parentDir}`);
      try {
        // Create parent directory with -p flag (recursive, like mkdir -p)
        await runMpremote(["connect", connect, "fs", "mkdir", "-p", parentDir], { retryOnFailure: true });
        log.debug(`cpToDevice: ✓ Parent directory created: ${parentDir}`);
      } catch (mkdirError: any) {
        // Directory might already exist, which is fine
        const errorStr = String(mkdirError?.message || mkdirError).toLowerCase();
        if (!errorStr.includes("file exists") && !errorStr.includes("directory exists")) {
          log.warn(`cpToDevice: ⚠ Failed to create parent directory ${parentDir}:`, mkdirError);
          // Continue anyway - the directory might already exist
        } else {
          log.debug(`cpToDevice: ✓ Parent directory already exists: ${parentDir}`);
        }
      }
    }

    // For cp TO device FROM local, device path needs : prefix
    const devicePathWithPrefix = deviceArg === "/" ? ":" : `:${deviceArg}`;
    const commandArgs = ["connect", connect, "fs", "cp", localPath, devicePathWithPrefix];
    const command = `mpremote ${commandArgs.map(arg => `"${arg}"`).join(' ')}`;

    log.debug(`cpToDevice: Executing command: ${command}`);
    log.debug(`cpToDevice: Device path: ${devicePath} -> ${deviceArg} -> ${devicePathWithPrefix}`);
    await runMpremote(commandArgs, { retryOnFailure: true });

    // Invalidate cache since filesystem changed
    clearFileTreeCache();
  } catch (error: any) {
    log.error(`cpToDevice: Upload failed:`, error);

    // Mark connection as unhealthy
    connectionManager.markUnhealthy(connect);

    // Check error type
    const errorStr = String(error?.message || error).toLowerCase();

    // Check if it's a "No such file or directory" error (missing parent directory)
    if (errorStr.includes("no such file or directory") || errorStr.includes("file not found")) {
      log.debug(`cpToDevice: Directory missing error detected. Attempting to create parent directories...`);
      
      const deviceArg = devicePath && devicePath !== "/" ? devicePath : "/";
      const pathParts = deviceArg.split('/').filter(part => part.length > 0);
      
      // Create each directory level step by step
      for (let i = 1; i < pathParts.length; i++) {
        const partialPath = '/' + pathParts.slice(0, i).join('/');
        try {
          log.debug(`cpToDevice: Creating directory level: ${partialPath}`);
          await runMpremote(["connect", connect, "fs", "mkdir", partialPath], { retryOnFailure: false });
        } catch (mkdirErr: any) {
          const mkdirErrStr = String(mkdirErr?.message || mkdirErr).toLowerCase();
          if (!mkdirErrStr.includes("file exists") && !mkdirErrStr.includes("directory exists")) {
            log.warn(`cpToDevice: Could not create ${partialPath}:`, mkdirErr);
          }
        }
      }
      
      // Retry the original copy operation
      try {
        log.debug(`cpToDevice: Retrying copy after creating directories...`);
        const devicePathWithPrefix = deviceArg === "/" ? ":" : `:${deviceArg}`;
        await runMpremote(["connect", connect, "fs", "cp", localPath, devicePathWithPrefix], { retryOnFailure: false });
        log.debug(`cpToDevice: ✓ Copy succeeded after creating directories!`);
        clearFileTreeCache();
        return; // Success!
      } catch (retryError: any) {
        log.error(`cpToDevice: Retry also failed:`, retryError);
        // Continue to other error handling below
      }
    }

    // Check if it's a read-only file system error
    if (errorStr.includes("read-only file system")) {
      log.debug(`cpToDevice: Read-only file system detected. Attempting recovery...`);

      // Try to get filesystem information
      try {
        const { stdout: statOutput } = await runMpremote(["connect", connect, "fs", "stat", "/"], { retryOnFailure: false });
        log.debug(`cpToDevice: Root filesystem stat:`, statOutput);
      } catch (statError) {
        log.error(`cpToDevice: Could not get filesystem stat:`, statError);
      }

      // Try recovery methods
      log.debug(`cpToDevice: Attempting recovery methods...`);

      // Method 1: Try soft reset
      try {
        log.debug(`cpToDevice: Attempting soft reset...`);
        await runMpremote(["connect", connect, "reset"], { retryOnFailure: false });
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for reset
        log.debug(`cpToDevice: Soft reset completed`);

        // Try the upload again after reset
        log.debug(`cpToDevice: Retrying upload after reset...`);
        const deviceArgRetry = devicePath && devicePath !== "/" ? devicePath : "/";
        const devicePathWithPrefixRetry = deviceArgRetry === "/" ? ":" : `:${deviceArgRetry}`;
        await runMpremote(["connect", connect, "fs", "cp", localPath, devicePathWithPrefixRetry], { retryOnFailure: false });
        log.debug(`cpToDevice: Upload succeeded after reset!`);

        // Invalidate cache since filesystem changed
        clearFileTreeCache();
        return; // Success, don't throw error
      } catch (resetError) {
        log.error(`cpToDevice: Reset recovery failed:`, resetError);
      }

      // Method 2: Try to remount filesystem (if supported)
      try {
        log.debug(`cpToDevice: Attempting filesystem remount...`);
        await runMpremote(["connect", connect, "exec", "import os; os.umount('/'); os.mount(os.VfsFat(os.sdcard()), '/')"], { retryOnFailure: false });
        log.debug(`cpToDevice: Filesystem remount attempted`);

        // Try upload again
        const deviceArgRemount = devicePath && devicePath !== "/" ? devicePath : "/";
        const devicePathWithPrefixRemount = deviceArgRemount === "/" ? ":" : `:${deviceArgRemount}`;
        await runMpremote(["connect", connect, "fs", "cp", localPath, devicePathWithPrefixRemount], { retryOnFailure: false });
        log.debug(`cpToDevice: Upload succeeded after remount!`);

        // Invalidate cache since filesystem changed
        clearFileTreeCache();
        return; // Success, don't throw error
      } catch (remountError) {
        log.error(`cpToDevice: Remount recovery failed:`, remountError);
      }

      // Method 3: Check if we can write to a test file
      try {
        log.debug(`cpToDevice: Testing write permissions...`);
        await runMpremote(["connect", connect, "exec", "f = open('test_write.tmp', 'w'); f.write('test'); f.close()"], { retryOnFailure: false });
        log.debug(`cpToDevice: Write test succeeded - filesystem is writable`);
      } catch (testError) {
        log.error(`cpToDevice: Write test failed:`, testError);
      }
    }

    connectionManager.markUnhealthy(connect);
    throw error;
  }
}

export async function uploadReplacing(localPath: string, devicePath: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  try {
    // Ensure parent directories exist on device before uploading
    const deviceArg = devicePath && devicePath !== "/" ? devicePath : "/";
    const parentDir = deviceArg.substring(0, deviceArg.lastIndexOf('/'));
    
    if (parentDir && parentDir !== "" && parentDir !== "/") {
      log.debug(`uploadReplacing: Creating parent directory: ${parentDir}`);
      try {
        // Create parent directory with -p flag (recursive, like mkdir -p)
        await runMpremote(["connect", connect, "fs", "mkdir", "-p", parentDir], { retryOnFailure: true });
        log.debug(`uploadReplacing: ✓ Parent directory created: ${parentDir}`);
      } catch (mkdirError: any) {
        // Directory might already exist, which is fine
        const errorStr = String(mkdirError?.message || mkdirError).toLowerCase();
        if (!errorStr.includes("file exists") && !errorStr.includes("directory exists")) {
          log.warn(`uploadReplacing: ⚠ Failed to create parent directory ${parentDir}:`, mkdirError);
          // Continue anyway - the directory might already exist
        } else {
          log.debug(`uploadReplacing: ✓ Parent directory already exists: ${parentDir}`);
        }
      }
    }

    // For replacing upload, use mpremote fs cp with -f flag to force overwrite
    const devicePathWithPrefix = deviceArg === "/" ? ":" : `:${deviceArg}`;
    await runMpremote(["connect", connect, "fs", "cp", "-f", localPath, devicePathWithPrefix], { retryOnFailure: true });

    // Invalidate cache since filesystem changed
    clearFileTreeCache();
  } catch (error: any) {
    log.error(`uploadReplacing: Upload failed:`, error);

    // Mark connection as unhealthy
    connectionManager.markUnhealthy(connect);

    // Check error type
    const errorStr = String(error?.message || error).toLowerCase();

    // Check if it's a "No such file or directory" error (missing parent directory)
    if (errorStr.includes("no such file or directory") || errorStr.includes("file not found")) {
      log.debug(`uploadReplacing: Directory missing error detected. Attempting to create parent directories...`);
      
      const deviceArg = devicePath && devicePath !== "/" ? devicePath : "/";
      const pathParts = deviceArg.split('/').filter(part => part.length > 0);
      
      // Create each directory level step by step
      for (let i = 1; i < pathParts.length; i++) {
        const partialPath = '/' + pathParts.slice(0, i).join('/');
        try {
          log.debug(`uploadReplacing: Creating directory level: ${partialPath}`);
          await runMpremote(["connect", connect, "fs", "mkdir", partialPath], { retryOnFailure: false });
        } catch (mkdirErr: any) {
          const mkdirErrStr = String(mkdirErr?.message || mkdirErr).toLowerCase();
          if (!mkdirErrStr.includes("file exists") && !mkdirErrStr.includes("directory exists")) {
            log.warn(`uploadReplacing: Could not create ${partialPath}:`, mkdirErr);
          }
        }
      }
      
      // Retry the original upload operation
      try {
        log.debug(`uploadReplacing: Retrying upload after creating directories...`);
        const devicePathWithPrefix = deviceArg === "/" ? ":" : `:${deviceArg}`;
        await runMpremote(["connect", connect, "fs", "cp", "-f", localPath, devicePathWithPrefix], { retryOnFailure: false });
        log.debug(`uploadReplacing: ✓ Upload succeeded after creating directories!`);
        clearFileTreeCache();
        return; // Success!
      } catch (retryError: any) {
        log.error(`uploadReplacing: Retry also failed:`, retryError);
        // Continue to throw original error
      }
    }

    connectionManager.markUnhealthy(connect);
    throw error;
  }
}

export async function deleteFile(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const pythonCode = `import os; os.remove('${p}')`;
  await runMpremote(["connect", connect, "exec", pythonCode]);
}

export async function deleteDirectoryRecursive(p: string, connect: string): Promise<void> {
  log.debug(`deleteDirectoryRecursive: Starting recursive delete for ${p}`);

  try {
    // First, list all contents of the directory
    const { stdout } = await runMpremote(["connect", connect, "fs", "ls", p], { retryOnFailure: true });
    const lines = String(stdout || "").split(/\r?\n/).filter(line => line.trim());

    log.debug(`deleteDirectoryRecursive: Found ${lines.length} items in ${p}`);

    // Delete each item in the directory
    for (const line of lines) {
      if (!line.trim() || line.includes('ls')) continue;

      const parts = line.trim().split(/\s+/).filter(part => part.length > 0);
      if (parts.length >= 2) {
        const size = parseInt(parts[0]) || 0;
        const filename = parts.slice(1).join(' ');
        const isDir = size === 0 && filename.endsWith('/');

        const itemPath = p === "/" ? `/${filename.replace(/\/$/, '')}` : `${p}/${filename.replace(/\/$/, '')}`;

        log.debug(`deleteDirectoryRecursive: Processing ${itemPath} (${isDir ? 'dir' : 'file'})`);

        if (isDir) {
          // Recursively delete subdirectory
          await deleteDirectoryRecursive(itemPath, connect);
        } else {
          // Delete file
          try {
            await runMpremote(["connect", connect, "fs", "rm", itemPath], { retryOnFailure: true });
            log.debug(`deleteDirectoryRecursive: Deleted file ${itemPath}`);
          } catch (fileError: any) {
            log.warn(`deleteDirectoryRecursive: Failed to delete file ${itemPath}:`, fileError);
            // Continue with other files even if one fails
          }
        }
      }
    }

    // Finally, delete the now-empty directory
    log.debug(`deleteDirectoryRecursive: Deleting empty directory ${p}`);
    await runMpremote(["connect", connect, "fs", "rmdir", p], { retryOnFailure: true });
    log.debug(`deleteDirectoryRecursive: Successfully deleted directory ${p}`);

  } catch (error: any) {
    log.error(`deleteDirectoryRecursive: Failed to delete directory ${p}:`, error);
    throw error;
  }
}

export async function deleteAny(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  try {
    // Check if the path is a directory to determine if we need recursive deletion
    const fileInfo = await getFileInfo(p);
    const isDirectory = fileInfo?.isDir || false;

    // Use mpremote fs rm command with -r flag for directories, without for files
    const pathArg = p && p !== "/" ? p : "/";
    const args = ["connect", connect, "fs", "rm"];

    // Add -r flag for directories to handle non-empty folders
    if (isDirectory) {
      args.push("-r");
    }

    args.push(pathArg);
    await runMpremote(args, { retryOnFailure: true });

    // Invalidate cache since filesystem changed
    clearFileTreeCache();
  } catch (error: any) {
    const errorMessage = String(error?.message || error).toLowerCase();

    // Check if it's OSError: 39 (Directory not empty)
    if (errorMessage.includes("oserror: 39") || errorMessage.includes("directory not empty")) {
      log.debug(`deleteAny: Directory not empty, attempting recursive delete for ${p}`);

      try {
        // Fallback: Use manual recursive deletion for non-empty directories
        await deleteDirectoryRecursive(p, connect);
        log.debug(`deleteAny: Successfully deleted directory recursively: ${p}`);

        // Invalidate cache since filesystem changed
        clearFileTreeCache();
        return;
      } catch (recursiveError: any) {
        log.error(`deleteAny: Recursive delete also failed for ${p}:`, recursiveError);
        connectionManager.markUnhealthy(connect);
        throw new Error(`Failed to delete directory ${p}: ${recursiveError?.message || recursiveError}`);
      }
    }

    // Mark connection as unhealthy for other errors
    connectionManager.markUnhealthy(connect);
    throw error;
  }
}

export async function deleteFolderRecursive(p: string): Promise<void> {
  await deleteAny(p);
}

export async function fileExists(p: string): Promise<boolean> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  try {
    const pathArg = p && p !== "/" ? p : "/";
    await runMpremote(["connect", connect, "fs", "stat", pathArg]);
    return true; // Exit code 0 = success = file exists
  } catch (error: any) {
    const errorStr = String(error?.message || error).toLowerCase();
    // Check for "file not found" type errors
    if (errorStr.includes("no such file") ||
        errorStr.includes("file not found") ||
        errorStr.includes("does not exist")) {
      return false;
    }
    // Re-throw connection or other serious errors
    if (errorStr.includes("serialexception") ||
        errorStr.includes("device not configured") ||
        errorStr.includes("connection failed")) {
      log.warn(`Serial connection error during file check: ${errorStr}`);
      return false;
    }
    // For other errors, assume file doesn't exist
    return false;
  }
}

// Check file existence using sha256sum command (more reliable for detecting missing files)
export async function fileExistsSha256(p: string): Promise<boolean> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  try {
    const pathArg = p && p !== "/" ? p : "/";
    // Use sha256sum command to check file existence
    const { stdout } = await runMpremote(["connect", connect, "fs", "sha256sum", pathArg], { retryOnFailure: false });

    // If we get output, the file exists
    const output = String(stdout || "").trim();
    if (output && !output.includes("no such file") && !output.includes("file not found")) {
      return true;
    }
    return false;
  } catch (error: any) {
    const errorStr = String(error?.message || error).toLowerCase();
    // Check for "file not found" type errors
    if (errorStr.includes("no such file") ||
        errorStr.includes("file not found") ||
        errorStr.includes("does not exist") ||
        errorStr.includes("mpremote: no device found") ||
        errorStr.includes("device not found")) {
      return false;
    }
    // Re-throw connection or other serious errors
    if (errorStr.includes("serialexception") ||
        errorStr.includes("device not configured") ||
        errorStr.includes("connection failed")) {
      log.warn(`Serial connection error during sha256sum file check: ${errorStr}`);
      return false;
    }
    // For other errors, assume file doesn't exist
    return false;
  }
}

export async function getFileInfo(p: string): Promise<{mode: number, size: number, isDir: boolean, isReadonly: boolean} | null> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  try {
    const pathArg = p && p !== "/" ? p : "/";
    const { stdout } = await runMpremote(["connect", connect, "fs", "stat", pathArg]);

    // Parse mpremote fs stat output
    // Format: "path mode size mtime" (space-separated)
    const parts = stdout.trim().split(/\s+/);
    if (parts.length >= 4) {
      const mode = parseInt(parts[1]);
      const size = parseInt(parts[2]);

      return {
        mode: mode,
        size: size,
        isDir: (mode & 0x4000) !== 0,  // Check directory bit
        isReadonly: (mode & 0x0080) === 0  // Check readonly bit
      };
    }
    return null;
  } catch (error: any) {
    const errorStr = String(error?.message || error).toLowerCase();
    // Return null for file not found errors
    if (errorStr.includes("no such file") ||
        errorStr.includes("file not found") ||
        errorStr.includes("does not exist")) {
      return null;
    }
    // Re-throw connection errors
    throw error;
  }
}

export async function deleteAllInPath(rootPath: string): Promise<{deleted: string[], errors: string[], deleted_count?: number, error_count?: number}> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  const deleted: string[] = [];
  const errors: string[] = [];

  try {
    // For root path, we need to delete the contents, not the root directory itself
    if (rootPath === "/") {
      // First, get the list of items in the root directory
      const items = await listTreeStats("/");
      
      // Filter to get only direct children of the root (depth 1)
      const rootItems = items.filter(item => {
        const pathParts = item.path.split('/').filter(part => part.length > 0);
        return pathParts.length === 1; // Direct children of root
      });

      // Delete each root-level item individually (sequentially to avoid concurrent access)
      for (const item of rootItems) {
        try {
          log.debug(`deleteAllInPath: Deleting ${item.path}...`);
          await runMpremote(["connect", connect, "fs", "rm", "-r", item.path], { retryOnFailure: true });
          deleted.push(item.path);
          log.debug(`deleteAllInPath: Successfully deleted ${item.path}`);
        } catch (error: any) {
          errors.push(`Failed to delete ${item.path}: ${error?.message || error}`);
          connectionManager.markUnhealthy(connect);
          log.error(`deleteAllInPath: Failed to delete ${item.path}:`, error);
        }
      }
    } else {
      // For non-root paths, we can delete the directory itself
      try {
        await runMpremote(["connect", connect, "fs", "rm", "-r", rootPath], { retryOnFailure: true });
        deleted.push(rootPath);
      } catch (error: any) {
        errors.push(`Failed to delete ${rootPath}: ${error?.message || error}`);
        connectionManager.markUnhealthy(connect);
      }
    }

    // Invalidate cache since filesystem changed
    clearFileTreeCache();

    return { 
      deleted, 
      errors, 
      deleted_count: deleted.length, 
      error_count: errors.length 
    };
  } catch (error: any) {
    connectionManager.markUnhealthy(connect);
    return { 
      deleted: [], 
      errors: [String(error?.message || error)], 
      deleted_count: 0, 
      error_count: 1 
    };
  }
}

export async function runFile(localPath: string): Promise<{ stdout: string; stderr: string }>{
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const deviceArg = localPath && localPath !== "/" ? `"${localPath}"` : "/";
  const { stdout } = await runMpremote(["connect", connect, "fs", "run", deviceArg]);
  return { stdout: String(stdout||""), stderr: "" };
}

export async function reset(): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") return;

  try {
    // Use native mpremote reset command instead of Python exec
    await runMpremote(["connect", connect, "reset"]);
  } catch (error: any) {
    // Reset is not critical, so we don't throw errors
    // Just log the issue for debugging
    log.warn(`Reset command failed: ${error?.message || error}`);
  }
}

export async function listTreeStats(root: string): Promise<Array<{ path: string; isDir: boolean; size: number; mtime: number }>> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  try {
    // First try to use the cached tree-paths.json file
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const treePathsFile = path.join(workspaceFolder.uri.fsPath, '.mpy-workbench', 'tree-paths.json');

      try {
        // Check if file exists and is recent (within 30 seconds)
        const stats = fs.statSync(treePathsFile);
        const now = Date.now();
        const fileAge = now - stats.mtime.getTime();

        if (fileAge < 30000) { // 30 seconds
          log.debug(`listTreeStats: Using cached tree-paths.json (age: ${fileAge}ms)`);

          // Read and parse the cached file
          const cachedData = JSON.parse(fs.readFileSync(treePathsFile, 'utf8'));

          // Convert parsed lines to the expected format
          const result: Array<{ path: string; isDir: boolean; size: number; mtime: number }> = [];

          for (const item of cachedData) {
            // For now, use default values for size and mtime since we don't have them in the cached data
            // In a future enhancement, we could store this information too
            result.push({
              path: item.fullPath,
              isDir: item.isDir,
              size: 0, // Default size
              mtime: Date.now() / 1000 // Current time as fallback
            });
          }

          log.debug(`listTreeStats: Loaded ${result.length} items from cache`);
          return result;
        } else {
          log.debug(`listTreeStats: Cached file too old (${fileAge}ms), refreshing...`);
        }
      } catch (cacheError) {
        log.debug(`listTreeStats: Could not read cached file:`, cacheError);
      }
    }

    // Fallback to original method if cache is not available or too old
    log.debug(`listTreeStats: Using original mpremote fs tree method`);

    // Use mpremote fs tree command to get hierarchical file listing
    const rootArg = root && root !== "/" ? root : "";
    const { stdout } = await runMpremote(["connect", connect, "fs", "tree"].concat(rootArg ? [rootArg] : []), { retryOnFailure: true });

    // Parse the tree output to extract file information
    const lines = String(stdout || "").split(/\r?\n/).filter(line => line.trim());
    const result: Array<{ path: string; isDir: boolean; size: number; mtime: number }> = [];

    for (const line of lines) {
      try {
        const trimmed = line.trim();
        // Skip empty lines and command echo
        if (!trimmed || trimmed.includes('tree')) continue;

        // Parse tree output format (simplified parsing)
        // Tree output typically shows hierarchical structure with file sizes
        const parts = trimmed.split(/\s+/).filter(part => part.length > 0);
        if (parts.length >= 2) {
          const size = parseInt(parts[0]) || 0;
          const filename = parts.slice(1).join(' ');
          const isDir = filename.endsWith('/');

          // Remove trailing slash from directory names
          const cleanName = filename.replace(/\/$/, '');

          result.push({
            path: cleanName,
            isDir,
            size,
            mtime: Date.now() / 1000 // Current time as fallback
          });
        }
      } catch {
        // Skip lines that can't be parsed
      }
    }

    return result;
  } catch (error) {
    connectionManager.markUnhealthy(connect);
    throw error;
  }
}

export function cancelAll(): void {
  try { currentChild?.kill('SIGKILL'); } catch {}
  currentChild = null;
}

// Health check function to verify connection status
export async function healthCheck(port?: string): Promise<{ healthy: boolean; port: string; responseTime?: number }> {
  const startTime = Date.now();
  const connect = port || normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");

  try {
    // Quick health check using fs tree to verify connection
    await runMpremote(["connect", connect, "fs", "tree"], { retryOnFailure: false });
    const responseTime = Date.now() - startTime;

    // Mark connection as healthy
    connectionManager.markHealthy(connect);
    return { healthy: true, port: connect, responseTime };
  } catch (error) {
    connectionManager.markUnhealthy(connect);
    return { healthy: false, port: connect };
  }
}

// Get connection statistics for debugging/monitoring
export function getConnectionStats(): {
  activeConnections: number;
  connectionManagerStats: any;
  currentChildPid?: number;
} {
  return {
    activeConnections: connectionManager.getStats().activeConnections,
    connectionManagerStats: connectionManager.getStats(),
    currentChildPid: currentChild?.pid
  };
}

// Optimized function to get both file list and sizes in one call
export async function getBoardFilesAndSizes(rootPath: string = "/"): Promise<{
  files: Map<string, { size: number; isDir: boolean }>;
  directories: Set<string>;
}> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  try {
    // Get tree output with sizes in one call
    const { stdout } = await runMpremote(["connect", connect, "fs", "tree", "-s"], { retryOnFailure: true });
    const files = new Map<string, { size: number; isDir: boolean }>();
    const directories = new Set<string>();

    const lines = String(stdout || "").split(/\r?\n/).filter(line => line.trim());
    const pathStack: string[] = [];

    // Regex for file with size: [   1234]  filename.ext
    const fileRe = /^\[\s*(\d+)\s*\]\s+(.+)$/;

    for (const line of lines) {
      if (!line.trim() || line.includes('tree') || line === ':/') continue;

      // Determine level by counting indentation
      let level = 0;
      let pos = 0;
      while (pos < line.length) {
        const remaining = line.substring(pos);
        if (remaining.startsWith('├──') || remaining.startsWith('└──')) {
          pos += 3;
          break;
        } else if (remaining.startsWith('│   ')) {
          level += 1;
          pos += 4;
        } else if (remaining.startsWith('    ')) {
          level += 1;
          pos += 4;
        } else {
          break;
        }
      }

      const remaining = line.substring(pos).trim();

      // Check if it's a file with size
      const fileMatch = fileRe.exec(remaining);
      if (fileMatch) {
        const size = parseInt(fileMatch[1]);
        const name = fileMatch[2].trim();

        // Adjust path stack to current level
        pathStack.splice(level);

        // Build full path
        let fullPath: string;
        if (pathStack.length === 0) {
          fullPath = name;
        } else {
          fullPath = pathStack.join('/') + '/' + name;
        }

        // Ensure path starts with /
        if (!fullPath.startsWith('/')) {
          fullPath = '/' + fullPath;
        }

        files.set(fullPath, { size, isDir: false });
        continue;
      }

      // If not a file, it's a directory
      const dirName = remaining.trim();
      if (dirName) {
        // Adjust path stack to current level
        pathStack.splice(level);

        // Build full path for directory
        let dirPath: string;
        if (pathStack.length === 0) {
          dirPath = dirName;
        } else {
          dirPath = pathStack.join('/') + '/' + dirName;
        }

        // Ensure path starts with /
        if (!dirPath.startsWith('/')) {
          dirPath = '/' + dirPath;
        }

        directories.add(dirPath);
        pathStack.push(dirName);
      }
    }

    return { files, directories };
  } catch (error) {
    log.error(`getBoardFilesAndSizes: Failed to get file data:`, error);
    throw error;
  }
}

// Legacy function for backward compatibility
export async function getBoardFileSizes(rootPath: string = "/"): Promise<Map<string, number>> {
  const result = await getBoardFilesAndSizes(rootPath);
  const fileSizes = new Map<string, number>();
  for (const [path, info] of result.files) {
    fileSizes.set(path, info.size);
  }
  return fileSizes;
}

export async function mvOnDevice(src: string, dst: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  try {
    const srcArg = src && src !== "/" ? `"${src}"` : "/";
    const dstArg = dst && dst !== "/" ? `"${dst}"` : "/";
    await runMpremote(["connect", connect, "fs", "mv", srcArg, dstArg]);
    
    // Invalidate cache since filesystem changed
    clearFileTreeCache();
  } catch (error: any) {
    throw new Error(`Move/rename failed: ${error?.message || error}`);
  }
}

// Cleanup function for extension deactivation
export function cleanupConnections(): void {
  connectionManager.stop();
  cancelAll();
}

