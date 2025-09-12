export async function mvOnDevice(src: string, dst: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  try {
    const srcArg = src && src !== "/" ? `"${src}"` : "/";
    const dstArg = dst && dst !== "/" ? `"${dst}"` : "/";
    await runMpremote(["connect", connect, "fs", "mv", srcArg, dstArg]);
  } catch (error: any) {
    throw new Error(`Move/rename failed: ${error?.message || error}`);
  }
}
import { execFile, ChildProcess, exec } from "node:child_process";
import * as vscode from "vscode";
import * as path from "node:path";

function normalizeConnect(c: string): string {
  if (c.startsWith("serial://")) return c.replace(/^serial:\/\//, "");
  if (c.startsWith("serial:/")) return c.replace(/^serial:\//, "");
  return c;
}

let currentChild: ChildProcess | null = null;

// Connection Manager for optimized mpremote connections
class ConnectionManager {
  private activeConnections: Map<string, { lastUsed: number; isHealthy: boolean }> = new Map();
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
    this.activeConnections.set(port, { lastUsed: now, isHealthy: true });
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

  // Clean up old connections
  private cleanup(): void {
    const now = Date.now();
    for (const [port, connection] of this.activeConnections.entries()) {
      if ((now - connection.lastUsed) > this.CONNECTION_TIMEOUT) {
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

export function runMpremote(args: string[], opts: { cwd?: string; retryOnFailure?: boolean } = {}): Promise<{ stdout: string; stderr: string }>{
  return new Promise((resolve, reject) => {
    const maxRetries = opts.retryOnFailure !== false ? 2 : 0;
    let attempt = 0;

    const executeCommand = () => {
      attempt++;

      // Extract port from connect command for connection management
      let port = "";
      const connectIndex = args.indexOf("connect");
      if (connectIndex !== -1 && connectIndex + 1 < args.length) {
        port = args[connectIndex + 1];
        // Get connection info from manager
        const connection = connectionManager.getConnection(port);
        // Mark as healthy initially
        connectionManager.markHealthy(port);
      }

      const escapedArgs = args.map(arg => {
        if (arg.includes('\n') || arg.includes('"') || arg.includes('$') || arg.includes('`')) {
          return `'${arg.replace(/'/g, "'\\''")}'`;
        }
        return `"${arg}"`;
      });

      const cmd = `mpremote ${escapedArgs.join(' ')}`;

      const child = exec(cmd, { cwd: opts.cwd }, (err, stdout, stderr) => {
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

          // Retry on transient errors
          if (attempt <= maxRetries && (
              errorStr.includes("device not configured") ||
              errorStr.includes("connection timeout") ||
              errorStr.includes("serial read failed")
          )) {
            console.log(`mpremote command failed (attempt ${attempt}/${maxRetries + 1}), retrying...`);
            setTimeout(executeCommand, 500 * attempt); // Exponential backoff
            return;
          }

          return reject(new Error(emsg || "mpremote error"));
        }

        // Mark connection as healthy on success
        if (port) {
          connectionManager.markHealthy(port);
        }

        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });

      currentChild = child;
    };

    executeCommand();
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
    console.log(`[DEBUG] populateFileTreeCache: Fetching complete file tree`);
    const { stdout } = await runMpremote(["connect", "auto", "fs", "tree"], { retryOnFailure: true });

    console.log(`[DEBUG] populateFileTreeCache: Raw tree output:\n${stdout}`);

    // Parse into hierarchical structure
    const parsedLines = parseTreeLines(String(stdout || ""));
    console.log(`[DEBUG] populateFileTreeCache: Parsed ${parsedLines.length} lines:`, parsedLines.map(l => `${l.fullPath} (depth: ${l.depth})`));

    const treeRoot = buildTreeFromParsedLines(parsedLines);
    console.log(`[DEBUG] populateFileTreeCache: Built tree with ${treeRoot.children.length} root children`);

    globalFileTreeCache = treeRoot;
    lastTreeUpdate = Date.now();

    console.log(`[DEBUG] populateFileTreeCache: Cache populated with ${parsedLines.length} items`);
  } catch (error) {
    console.error(`[DEBUG] populateFileTreeCache: Failed to populate cache:`, error);
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

  console.log(`[DEBUG] getEntriesFromCache: Looking for ${targetPath} in cache`);
  console.log(`[DEBUG] getEntriesFromCache: Cache has ${globalFileTreeCache.children.length} root children`);

  if (targetPath === "/") {
    const result = globalFileTreeCache.children.map(child => ({
      name: child.name,
      isDir: child.isDir
    }));
    console.log(`[DEBUG] getEntriesFromCache: Found ${result.length} root items:`, result.map(r => `${r.name} (${r.isDir ? 'dir' : 'file'})`));
    return result;
  }

  // Find the target directory node
  const pathParts = targetPath.split("/").filter(p => p);
  console.log(`[DEBUG] getEntriesFromCache: Path parts for ${targetPath}:`, pathParts);

  let currentNode = globalFileTreeCache;
  console.log(`[DEBUG] getEntriesFromCache: Starting from root node`);

  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    console.log(`[DEBUG] getEntriesFromCache: Looking for '${part}' in ${currentNode.children.length} children`);
    console.log(`[DEBUG] getEntriesFromCache: Available children:`, currentNode.children.map(c => c.name));

    const found = currentNode.children.find(child => child.name === part);
    if (!found) {
      console.log(`[DEBUG] getEntriesFromCache: Path ${targetPath} not found in cache - '${part}' not found`);
      console.log(`[DEBUG] getEntriesFromCache: Current node children:`, currentNode.children.map(c => `${c.name} (${c.isDir ? 'dir' : 'file'})`));
      return null;
    }
    currentNode = found;
    console.log(`[DEBUG] getEntriesFromCache: Found '${part}', continuing to next level`);
  }

  const result = currentNode.children.map(child => ({
    name: child.name,
    isDir: child.isDir
  }));

  console.log(`[DEBUG] getEntriesFromCache: Found ${result.length} items for ${targetPath}:`, result.map(r => `${r.name} (${r.isDir ? 'dir' : 'file'})`));
  return result;
}

// Clear the cache (useful when files change)
export function clearFileTreeCache(): void {
  globalFileTreeCache = null;
  lastTreeUpdate = 0;
  console.log(`[DEBUG] clearFileTreeCache: Cache cleared`);
}

// Force refresh the cache
export async function refreshFileTreeCache(): Promise<void> {
  console.log(`[DEBUG] refreshFileTreeCache: Forcing cache refresh`);
  globalFileTreeCache = null;
  lastTreeUpdate = 0;
  await populateFileTreeCache();
}

// Debug function to manually test tree parsing
export async function debugTreeParsing(): Promise<void> {
  try {
    console.log(`[DEBUG] debugTreeParsing: Testing tree command manually`);

    // Get raw tree output
    const { stdout } = await runMpremote(["connect", "auto", "fs", "tree"], { retryOnFailure: true });
    console.log(`[DEBUG] debugTreeParsing: Raw tree output:\n${stdout}`);

    // Parse it
    const parsedLines = parseTreeLines(String(stdout || ""));
    console.log(`[DEBUG] debugTreeParsing: Parsed ${parsedLines.length} lines:`, parsedLines);

    // Build tree
    const treeRoot = buildTreeFromParsedLines(parsedLines);
    console.log(`[DEBUG] debugTreeParsing: Built tree with ${treeRoot.children.length} root children`);

    // Test getting entries for root
    const rootEntries = getEntriesFromCache("/");
    console.log(`[DEBUG] debugTreeParsing: Root entries:`, rootEntries);

    // Test getting entries for first subdirectory if exists
    if (treeRoot.children.length > 0 && treeRoot.children[0].isDir) {
      const subPath = `/${treeRoot.children[0].name}`;
      console.log(`[DEBUG] debugTreeParsing: Testing subpath: ${subPath}`);
      const subEntries = getEntriesFromCache(subPath);
      console.log(`[DEBUG] debugTreeParsing: Sub entries for ${subPath}:`, subEntries);
    }

  } catch (error) {
    console.error(`[DEBUG] debugTreeParsing: Error:`, error);
  }
}

// Debug function to check filesystem status and read-only issues
export async function debugFilesystemStatus(): Promise<void> {
  try {
    console.log(`[DEBUG] debugFilesystemStatus: Checking filesystem status`);

    // Check root filesystem stat
    console.log(`[DEBUG] debugFilesystemStatus: Checking root filesystem stat...`);
    const { stdout: statOutput } = await runMpremote(["connect", "auto", "fs", "stat", "/"], { retryOnFailure: false });
    console.log(`[DEBUG] debugFilesystemStatus: Root filesystem stat:\n${statOutput}`);

    // Try to check mount information
    console.log(`[DEBUG] debugFilesystemStatus: Checking mount information...`);
    try {
      const { stdout: mountOutput } = await runMpremote(["connect", "auto", "exec", "import os; print(os.listdir('/'))"], { retryOnFailure: false });
      console.log(`[DEBUG] debugFilesystemStatus: Root directory listing:\n${mountOutput}`);
    } catch (mountError) {
      console.error(`[DEBUG] debugFilesystemStatus: Could not list root directory:`, mountError);
    }

    // Try to check if we can write to root
    console.log(`[DEBUG] debugFilesystemStatus: Testing write permissions...`);
    try {
      await runMpremote(["connect", "auto", "exec", "f = open('test_write.tmp', 'w'); f.write('test'); f.close()"], { retryOnFailure: false });
      console.log(`[DEBUG] debugFilesystemStatus: ✓ Write test to root succeeded`);

      // Clean up test file
      try {
        await runMpremote(["connect", "auto", "exec", "import os; os.remove('test_write.tmp')"], { retryOnFailure: false });
        console.log(`[DEBUG] debugFilesystemStatus: ✓ Test file cleanup succeeded`);
      } catch (cleanupError) {
        console.log(`[DEBUG] debugFilesystemStatus: ⚠ Test file cleanup failed:`, cleanupError);
      }
    } catch (writeError) {
      console.error(`[DEBUG] debugFilesystemStatus: ✗ Write test to root failed:`, writeError);
    }

    // Try to check if we can write to a subdirectory
    console.log(`[DEBUG] debugFilesystemStatus: Testing write permissions in subdirectory...`);
    try {
      await runMpremote(["connect", "auto", "exec", "import os; os.mkdir('test_dir')"], { retryOnFailure: false });
      console.log(`[DEBUG] debugFilesystemStatus: ✓ Directory creation succeeded`);

      await runMpremote(["connect", "auto", "exec", "f = open('test_dir/test_write.tmp', 'w'); f.write('test'); f.close()"], { retryOnFailure: false });
      console.log(`[DEBUG] debugFilesystemStatus: ✓ Write test in subdirectory succeeded`);

      // Clean up
      try {
        await runMpremote(["connect", "auto", "exec", "import os; os.remove('test_dir/test_write.tmp'); os.rmdir('test_dir')"], { retryOnFailure: false });
        console.log(`[DEBUG] debugFilesystemStatus: ✓ Cleanup succeeded`);
      } catch (cleanupError) {
        console.log(`[DEBUG] debugFilesystemStatus: ⚠ Cleanup failed:`, cleanupError);
      }
    } catch (subdirError) {
      console.error(`[DEBUG] debugFilesystemStatus: ✗ Subdirectory write test failed:`, subdirError);
    }

    // Check MicroPython version and build
    console.log(`[DEBUG] debugFilesystemStatus: Checking MicroPython version...`);
    try {
      const { stdout: versionOutput } = await runMpremote(["connect", "auto", "exec", "import sys; print('MicroPython version:', sys.version)"], { retryOnFailure: false });
      console.log(`[DEBUG] debugFilesystemStatus: Version info:\n${versionOutput}`);
    } catch (versionError) {
      console.error(`[DEBUG] debugFilesystemStatus: Could not get version:`, versionError);
    }

  } catch (error) {
    console.error(`[DEBUG] debugFilesystemStatus: Error during filesystem check:`, error);
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

  console.log(`[DEBUG] Parsing ${lines.length} tree lines`);

  for (const line of lines) {
    if (!line.trim() || line.includes('tree') || line === ':/' || line === ':') continue;

    console.log(`[DEBUG] Processing: "${line}"`);

    // Count tree drawing characters to determine depth
    // Each "│" or "├" or "└" represents a level in the hierarchy
    const treeChars = line.match(/([├└│])/g) || [];
    let depth = 0;

    // Count the tree structure characters
    for (const char of treeChars) {
      if (char === '├' || char === '└') {
        depth++;
      } else if (char === '│') {
        // Continuation character, counts as depth
        depth++;
      }
    }

    // Adjust depth - tree characters start from the left
    if (depth > 0) {
      depth = depth - 1; // Adjust because root level has 0 depth
    }

    console.log(`[DEBUG] Tree chars: ${treeChars.length}, Final depth: ${depth}`);

    // Extract name (remove tree prefixes ├── └── │)
    // First, try to match lines with tree drawing characters
    let nameMatch = line.match(/[├└]──\s+(.+)$/);
    if (!nameMatch) {
      // Try alternative pattern for continuation lines or different tree formats
      nameMatch = line.match(/[│├└]+\s*[├└]──\s+(.+)$/);
      if (!nameMatch) {
        // Try even more flexible pattern
        nameMatch = line.match(/[├└]\s*──\s*(.+)$/);
        if (!nameMatch) {
          console.log(`[DEBUG] No name match for: "${line}"`);
          continue;
        }
      }
    }

    const name = nameMatch[1].trim();
    console.log(`[DEBUG] Extracted name: "${name}"`);

    // Adjust directory stack to match current depth
    // The stack should have 'depth' elements for an item at depth 'depth'
    while (dirStack.length > depth) {
      const popped = dirStack.pop();
      console.log(`[DEBUG] Popped from stack: ${popped} (stack now: [${dirStack.join(', ')}])`);
    }

    // For debugging: show current stack state
    console.log(`[DEBUG] Current stack before processing: [${dirStack.join(', ')}]`);

    // Build full path
    const fullPath = dirStack.length === 0 ? `/${name}` : `${dirStack[dirStack.length - 1]}/${name}`;
    console.log(`[DEBUG] Built full path: ${fullPath}`);

    // Determine if it's a directory by checking if it has children in subsequent lines
    let isDir = false;
    const currentIndex = lines.indexOf(line);

    // Look ahead to see if there are lines with greater depth
    for (let j = currentIndex + 1; j < lines.length && j < currentIndex + 10; j++) { // Limit search to next 10 lines
      const nextLine = lines[j].trim();
      if (!nextLine || nextLine.includes('tree') || nextLine === ':') break;

      // Check if next line has tree characters indicating children
      const nextTreeMatch = nextLine.match(/[├└]──\s+/);
      if (nextTreeMatch) {
        // Count tree characters in next line
        const nextTreeChars = nextLine.match(/([├└│])/g) || [];
        const nextDepth = nextTreeChars.length;

        if (nextDepth > treeChars.length) {  // Must have more tree chars than current line
          isDir = true;
          console.log(`[DEBUG] ${name} is directory (has children at depth ${nextDepth})`);
          break;
        }
      }

      // If we hit a line at the same or lesser depth, stop looking
      const nextTreeChars = nextLine.match(/([├└│])/g) || [];
      if (nextTreeChars.length <= treeChars.length) {
        break;
      }
    }

    // Also check if it looks like a directory (no extension and reasonable name)
    if (!isDir && !name.includes('.') && name !== 'tree' && name.length > 0 && !name.startsWith('.')) {
      isDir = true;
      console.log(`[DEBUG] ${name} assumed directory (no extension)`);
    }

    console.log(`[DEBUG] Final determination: ${name} is ${isDir ? 'directory' : 'file'}`);

    result.push({ fullPath, name, isDir, depth });

    // Add to directory stack if it's a directory
    if (isDir) {
      dirStack.push(fullPath);
      console.log(`[DEBUG] Added to stack: ${fullPath} (stack: [${dirStack.join(', ')}])`);
    }
  }

  console.log(`[DEBUG] Parsed ${result.length} items:`, result.map(r => `${r.fullPath} (${r.isDir ? 'dir' : 'file'})`));
  return result;
}


// Build tree structure from parsed lines (helper function)
function buildTreeFromParsedLines(parsedLines: Array<{fullPath: string, name: string, isDir: boolean, depth: number}>): TreeNode {
  console.log(`[DEBUG] buildTreeFromParsedLines: Building tree from ${parsedLines.length} parsed lines`);

  const root: TreeNode = {
    name: "",
    isDir: true,
    children: [],
    fullPath: "/"
  };

  const nodeMap = new Map<string, TreeNode>();
  nodeMap.set("/", root);

  for (const item of parsedLines) {
    console.log(`[DEBUG] buildTreeFromParsedLines: Processing ${item.fullPath} (depth: ${item.depth})`);

    const pathParts = item.fullPath.split('/').filter(p => p);
    const parentPath = pathParts.length > 1 ? '/' + pathParts.slice(0, -1).join('/') : '/';

    console.log(`[DEBUG] buildTreeFromParsedLines: Path parts: [${pathParts.join(', ')}], parent: ${parentPath}`);

    const parentNode = nodeMap.get(parentPath);

    if (parentNode) {
      console.log(`[DEBUG] buildTreeFromParsedLines: Found parent ${parentPath}, adding ${item.name}`);

      const newNode: TreeNode = {
        name: item.name,
        isDir: item.isDir,
        children: [],
        fullPath: item.fullPath
      };

      parentNode.children.push(newNode);

      if (item.isDir) {
        nodeMap.set(item.fullPath, newNode);
        console.log(`[DEBUG] buildTreeFromParsedLines: Added directory ${item.fullPath} to nodeMap`);
      }

      console.log(`[DEBUG] buildTreeFromParsedLines: Added ${item.name} to ${parentPath}`);
    } else {
      console.log(`[DEBUG] buildTreeFromParsedLines: Parent ${parentPath} not found for ${item.fullPath}`);
    }
  }

  console.log(`[DEBUG] buildTreeFromParsedLines: Final tree structure:`);
  const printTree = (node: TreeNode, indent = 0) => {
    const prefix = '  '.repeat(indent);
    console.log(`${prefix}${node.name || '/'} (${node.isDir ? 'dir' : 'file'}) - ${node.children.length} children`);
    for (const child of node.children) {
      printTree(child, indent + 1);
    }
  };
  printTree(root);

  return root;
}

// Helper function to parse tree output and extract entries for a specific path
function parseTreeForPath(treeOutput: string, targetPath: string): { name: string; isDir: boolean }[] {
  console.log(`[DEBUG] parseTreeForPath: Parsing tree for path ${targetPath}`);

  try {
    // Parse tree into flat list with full paths
    const parsedLines = parseTreeLines(treeOutput);

    // Filter items that belong to the target path
    console.log(`[DEBUG] Filtering ${parsedLines.length} parsed lines for target path: ${targetPath}`);
    console.log(`[DEBUG] All parsed items:`, parsedLines.map(item => `${item.fullPath} (depth: ${item.depth})`));

    const targetItems = parsedLines.filter(item => {
      console.log(`[DEBUG] Checking item: ${item.fullPath} (depth: ${item.depth})`);

      if (targetPath === "/") {
        // For root, get only items at depth 0 (direct children of root)
        const matches = item.depth === 0;
        console.log(`[DEBUG] Root filter: ${item.fullPath} depth ${item.depth} -> ${matches ? 'KEEP' : 'FILTER OUT'}`);
        return matches;
      } else {
        // For subdirectories, get direct children of the target path
        const targetPathParts = targetPath.split('/').filter(p => p);
        const itemPathParts = item.fullPath.split('/').filter(p => p);

        console.log(`[DEBUG] Subdir filter: target parts: [${targetPathParts.join(', ')}], item parts: [${itemPathParts.join(', ')}]`);

        // Must be exactly one level deeper than target
        if (itemPathParts.length !== targetPathParts.length + 1) {
          console.log(`[DEBUG] Wrong depth: expected ${targetPathParts.length + 1}, got ${itemPathParts.length} -> FILTER OUT`);
          return false;
        }

        // Must start with the same path parts as target
        for (let i = 0; i < targetPathParts.length; i++) {
          if (itemPathParts[i] !== targetPathParts[i]) {
            console.log(`[DEBUG] Path mismatch at position ${i}: expected ${targetPathParts[i]}, got ${itemPathParts[i]} -> FILTER OUT`);
            return false;
          }
        }

        console.log(`[DEBUG] Subdir filter passed for: ${item.fullPath} -> KEEP`);
        return true;
      }
    });

    const result = targetItems.map(item => ({
      name: item.name,
      isDir: item.isDir
    }));

    console.log(`[DEBUG] parseTreeForPath: Found ${targetItems.length} items for ${targetPath}:`, targetItems.map(i => `${i.fullPath} (depth: ${i.depth})`));
    console.log(`[DEBUG] parseTreeForPath: Returning ${result.length} entries:`, result.map(r => `${r.name} (${r.isDir ? 'dir' : 'file'})`));
    return result;
  } catch (error) {
    console.error(`[DEBUG] parseTreeForPath: Error parsing tree:`, error);
    return [];
  }
}

export async function lsTyped(p: string): Promise<{ name: string; isDir: boolean }[]> {
  console.log(`[DEBUG] lsTyped: Getting entries for path ${p}`);

  try {
    // Check if cache needs to be populated or refreshed
    if (!isCacheValid()) {
      console.log(`[DEBUG] lsTyped: Cache invalid, populating...`);
      await populateFileTreeCache();
    } else {
      console.log(`[DEBUG] lsTyped: Using cached tree data`);
    }

    // Try to get entries from cache first
    const cachedResult = getEntriesFromCache(p);
    if (cachedResult && cachedResult.length > 0) {
      console.log(`[DEBUG] lsTyped: Found ${cachedResult.length} entries in cache for ${p}`);
      return cachedResult;
    }

    console.log(`[DEBUG] lsTyped: No cached results for ${p}, trying direct tree parsing`);

    // Fallback: direct tree parsing for this specific path
    const { stdout } = await runMpremote(["connect", "auto", "fs", "tree"], { retryOnFailure: true });
    const result = parseTreeForPath(String(stdout || ""), p);

    console.log(`[DEBUG] lsTyped: Direct parsing found ${result.length} entries for ${p}`);

    // If still no results, try fs ls as last resort
    if (result.length === 0) {
      console.log(`[DEBUG] lsTyped: No results from tree parsing, trying fs ls fallback`);
      try {
        const pathArg = p && p !== "/" ? p : "";
        const args = ["connect", "auto", "fs", "ls"].concat(pathArg ? [pathArg] : []);

        const { stdout: lsOutput } = await runMpremote(args, { retryOnFailure: true });
        console.log(`[DEBUG] lsTyped: Fallback ls output:\n${lsOutput}`);

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

        console.log(`[DEBUG] lsTyped: Fallback parsed ${fallbackResult.length} entries:`, fallbackResult);
        return fallbackResult;
      } catch (fallbackError) {
        console.error(`[DEBUG] lsTyped: Fallback also failed:`, fallbackError);
      }
    }

    return result;
  } catch (error) {
    console.error(`[DEBUG] lsTyped: Error for path ${p}: ${error}`);
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
    const deviceArg = devicePath && devicePath !== "/" ? devicePath : "/";
    await runMpremote(["connect", connect, "fs", "cp", deviceArg, localPath], { retryOnFailure: true });

    // Note: We don't clear cache here since we're only reading, not modifying
  } catch (error) {
    connectionManager.markUnhealthy(connect);
    throw error;
  }
}

export async function cpToDevice(localPath: string, devicePath: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  try {
    const deviceArg = devicePath && devicePath !== "/" ? devicePath : "/";
    console.log(`[DEBUG] cpToDevice: Executing mpremote connect ${connect} fs cp "${localPath}" "${deviceArg}"`);
    await runMpremote(["connect", connect, "fs", "cp", localPath, deviceArg], { retryOnFailure: true });

    // Invalidate cache since filesystem changed
    clearFileTreeCache();
  } catch (error: any) {
    console.error(`[DEBUG] cpToDevice: Upload failed:`, error);

    // Check if it's a read-only file system error
    const errorStr = String(error?.message || error).toLowerCase();
    if (errorStr.includes("read-only file system")) {
      console.log(`[DEBUG] cpToDevice: Read-only file system detected. Attempting recovery...`);

      // Try to get filesystem information
      try {
        const { stdout: statOutput } = await runMpremote(["connect", connect, "fs", "stat", "/"], { retryOnFailure: false });
        console.log(`[DEBUG] cpToDevice: Root filesystem stat:`, statOutput);
      } catch (statError) {
        console.error(`[DEBUG] cpToDevice: Could not get filesystem stat:`, statError);
      }

      // Try recovery methods
      console.log(`[DEBUG] cpToDevice: Attempting recovery methods...`);

      // Method 1: Try soft reset
      try {
        console.log(`[DEBUG] cpToDevice: Attempting soft reset...`);
        await runMpremote(["connect", connect, "reset"], { retryOnFailure: false });
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for reset
        console.log(`[DEBUG] cpToDevice: Soft reset completed`);

        // Try the upload again after reset
        console.log(`[DEBUG] cpToDevice: Retrying upload after reset...`);
        const deviceArgRetry = devicePath && devicePath !== "/" ? devicePath : "/";
        await runMpremote(["connect", connect, "fs", "cp", localPath, deviceArgRetry], { retryOnFailure: false });
        console.log(`[DEBUG] cpToDevice: Upload succeeded after reset!`);

        // Invalidate cache since filesystem changed
        clearFileTreeCache();
        return; // Success, don't throw error
      } catch (resetError) {
        console.error(`[DEBUG] cpToDevice: Reset recovery failed:`, resetError);
      }

      // Method 2: Try to remount filesystem (if supported)
      try {
        console.log(`[DEBUG] cpToDevice: Attempting filesystem remount...`);
        await runMpremote(["connect", connect, "exec", "import os; os.umount('/'); os.mount(os.VfsFat(os.sdcard()), '/')"], { retryOnFailure: false });
        console.log(`[DEBUG] cpToDevice: Filesystem remount attempted`);

        // Try upload again
        const deviceArgRemount = devicePath && devicePath !== "/" ? devicePath : "/";
        await runMpremote(["connect", connect, "fs", "cp", localPath, deviceArgRemount], { retryOnFailure: false });
        console.log(`[DEBUG] cpToDevice: Upload succeeded after remount!`);

        // Invalidate cache since filesystem changed
        clearFileTreeCache();
        return; // Success, don't throw error
      } catch (remountError) {
        console.error(`[DEBUG] cpToDevice: Remount recovery failed:`, remountError);
      }

      // Method 3: Check if we can write to a test file
      try {
        console.log(`[DEBUG] cpToDevice: Testing write permissions...`);
        await runMpremote(["connect", connect, "exec", "f = open('test_write.tmp', 'w'); f.write('test'); f.close()"], { retryOnFailure: false });
        console.log(`[DEBUG] cpToDevice: Write test succeeded - filesystem is writable`);
      } catch (testError) {
        console.error(`[DEBUG] cpToDevice: Write test failed:`, testError);
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
    // For replacing upload, use mpremote fs cp with -f flag to force overwrite
    const deviceArg = devicePath && devicePath !== "/" ? devicePath : "/";
    await runMpremote(["connect", connect, "fs", "cp", "-f", localPath, deviceArg], { retryOnFailure: true });
  } catch (error) {
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

export async function deleteAny(p: string): Promise<void> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  try {
    // Use mpremote fs rm command which handles both files and directories recursively
    const pathArg = p && p !== "/" ? p : "/";
    await runMpremote(["connect", connect, "fs", "rm", pathArg], { retryOnFailure: true });

    // Invalidate cache since filesystem changed
    clearFileTreeCache();
  } catch (error) {
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
      console.warn(`Serial connection error during file check: ${errorStr}`);
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

  try {
    // Use mpremote fs rm -r command for recursive deletion
    const pathArg = rootPath && rootPath !== "/" ? rootPath : "/";
    await runMpremote(["connect", connect, "fs", "rm", "-r", pathArg], { retryOnFailure: true });
    return { deleted: [rootPath], errors: [], deleted_count: 1, error_count: 0 };
  } catch (error: any) {
    connectionManager.markUnhealthy(connect);
    return { deleted: [], errors: [String(error?.message || error)], deleted_count: 0, error_count: 1 };
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
    console.warn(`Reset command failed: ${error?.message || error}`);
  }
}

export async function listTreeStats(root: string): Promise<Array<{ path: string; isDir: boolean; size: number; mtime: number }>> {
  const connect = normalizeConnect(vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto") || "auto");
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  try {
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

  try {
    // Quick health check using fs tree to verify connection
    await runMpremote(["connect", "auto", "fs", "tree"], { retryOnFailure: false });
    const responseTime = Date.now() - startTime;

    // Mark connection as healthy (using "auto" as the port identifier)
    connectionManager.markHealthy("auto");
    return { healthy: true, port: port || "auto", responseTime };
  } catch (error) {
    connectionManager.markUnhealthy("auto");
    return { healthy: false, port: port || "auto" };
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

// Cleanup function for extension deactivation
export function cleanupConnections(): void {
  connectionManager.stop();
  cancelAll();
}
