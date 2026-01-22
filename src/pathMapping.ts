import * as path from "node:path";
import * as fs from "node:fs/promises";

/**
 * Path mapping configuration for remapping local paths to device paths.
 *
 * Example configuration in .mpy-workbench/config.json:
 * {
 *   "autoSyncOnSave": true,
 *   "pathMappings": [
 *     { "local": "src/", "device": "/" },
 *     { "local": "lib/", "device": "/lib/" }
 *   ]
 * }
 *
 * With the above config:
 * - Local file: src/main.py → Device: /main.py
 * - Local file: src/boot.py → Device: /boot.py
 * - Local file: lib/utils.py → Device: /lib/utils.py
 */

export interface PathMapping {
  /** Local path prefix (relative to workspace root) */
  local: string;
  /** Device path prefix (where files should be placed on ESP32) */
  device: string;
}

export interface WorkspaceConfig {
  autoSyncOnSave?: boolean;
  pathMappings?: PathMapping[];
  [key: string]: any;
}

const MPY_WORKBENCH_DIR = ".mpy-workbench";
const MPY_CONFIG_FILE = "config.json";

/**
 * Read workspace config from .mpy-workbench/config.json
 */
export async function readWorkspaceConfig(
  wsPath: string,
): Promise<WorkspaceConfig> {
  try {
    const configPath = path.join(wsPath, MPY_WORKBENCH_DIR, MPY_CONFIG_FILE);
    const txt = await fs.readFile(configPath, "utf8");
    return JSON.parse(txt) as WorkspaceConfig;
  } catch {
    return {};
  }
}

/**
 * Write workspace config to .mpy-workbench/config.json
 */
export async function writeWorkspaceConfig(
  wsPath: string,
  config: WorkspaceConfig,
): Promise<void> {
  try {
    await fs.mkdir(path.join(wsPath, MPY_WORKBENCH_DIR), { recursive: true });
    const configPath = path.join(wsPath, MPY_WORKBENCH_DIR, MPY_CONFIG_FILE);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to write .mpy-workbench config", e);
  }
}

/**
 * Normalize a path by removing trailing slashes and ensuring consistent separators
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

/**
 * Apply path mappings to convert a local relative path to a device path.
 *
 * @param localRel - The local relative path (e.g., "src/main.py")
 * @param rootPath - The device root path (e.g., "/")
 * @param mappings - Array of path mappings from config
 * @returns The mapped device path (e.g., "/main.py")
 */
export function applyPathMappings(
  localRel: string,
  rootPath: string,
  mappings: PathMapping[] | undefined,
): string {
  const normalizedLocalRel = normalizePath(localRel);
  const normalizedRootPath = rootPath === "/" ? "" : normalizePath(rootPath);

  if (!mappings || mappings.length === 0) {
    // No mappings, use standard path joining
    if (normalizedRootPath === "") {
      return "/" + normalizedLocalRel;
    }
    return normalizedRootPath + "/" + normalizedLocalRel;
  }

  // Try to find a matching mapping (order matters - first match wins)
  for (const mapping of mappings) {
    const normalizedLocalPrefix = normalizePath(mapping.local);
    const normalizedDevicePrefix = normalizePath(mapping.device);

    // Check if the local path starts with this mapping's local prefix
    if (normalizedLocalRel === normalizedLocalPrefix) {
      // Exact match - the file IS the prefix (e.g., mapping "src" and file is "src")
      // This shouldn't normally happen for files, but handle it
      if (normalizedDevicePrefix === "" || normalizedDevicePrefix === "/") {
        return "/";
      }
      return normalizedDevicePrefix;
    }

    if (normalizedLocalRel.startsWith(normalizedLocalPrefix + "/")) {
      // The local path starts with the mapping prefix
      const relativePart = normalizedLocalRel.slice(
        normalizedLocalPrefix.length + 1,
      );

      // Build the device path
      let devicePath: string;
      if (normalizedDevicePrefix === "" || normalizedDevicePrefix === "/") {
        devicePath = "/" + relativePart;
      } else {
        devicePath = normalizedDevicePrefix + "/" + relativePart;
      }

      // If there's a root path, prepend it (unless device prefix already includes full path)
      if (
        normalizedRootPath !== "" &&
        !normalizedDevicePrefix.startsWith(normalizedRootPath)
      ) {
        // The device prefix is relative, prepend root
        if (normalizedDevicePrefix === "" || normalizedDevicePrefix === "/") {
          devicePath = normalizedRootPath + "/" + relativePart;
        } else {
          devicePath =
            normalizedRootPath +
            "/" +
            normalizedDevicePrefix +
            "/" +
            relativePart;
        }
      }

      return devicePath.replace(/\/+/g, "/");
    }
  }

  // No mapping matched, use standard path joining
  if (normalizedRootPath === "") {
    return "/" + normalizedLocalRel;
  }
  return normalizedRootPath + "/" + normalizedLocalRel;
}

/**
 * Reverse path mappings to convert a device path back to a local relative path.
 *
 * @param devicePath - The device path (e.g., "/main.py")
 * @param rootPath - The device root path (e.g., "/")
 * @param mappings - Array of path mappings from config
 * @returns The local relative path (e.g., "src/main.py")
 */
export function reversePathMappings(
  devicePath: string,
  rootPath: string,
  mappings: PathMapping[] | undefined,
): string {
  const normalizedDevicePath = normalizePath(devicePath);
  const normalizedRootPath = rootPath === "/" ? "" : normalizePath(rootPath);

  // First, strip the root path if present
  let relativeDevicePath = normalizedDevicePath;
  if (
    normalizedRootPath !== "" &&
    normalizedDevicePath.startsWith(normalizedRootPath + "/")
  ) {
    relativeDevicePath = normalizedDevicePath.slice(
      normalizedRootPath.length + 1,
    );
  } else if (normalizedDevicePath.startsWith("/")) {
    relativeDevicePath = normalizedDevicePath.slice(1);
  }

  if (!mappings || mappings.length === 0) {
    // No mappings, return as-is
    return relativeDevicePath;
  }

  // Try to find a matching reverse mapping
  for (const mapping of mappings) {
    const normalizedLocalPrefix = normalizePath(mapping.local);
    const normalizedDevicePrefix = normalizePath(mapping.device);

    // Handle the device prefix (stripping root path consideration)
    let effectiveDevicePrefix = normalizedDevicePrefix;
    if (effectiveDevicePrefix.startsWith("/")) {
      effectiveDevicePrefix = effectiveDevicePrefix.slice(1);
    }

    // Check if device path matches this mapping
    if (effectiveDevicePrefix === "" || effectiveDevicePrefix === "/") {
      // This mapping puts files at root
      // The relative device path should map back to local prefix + relative
      return normalizedLocalPrefix + "/" + relativeDevicePath;
    }

    if (relativeDevicePath === effectiveDevicePrefix) {
      // Exact match
      return normalizedLocalPrefix;
    }

    if (relativeDevicePath.startsWith(effectiveDevicePrefix + "/")) {
      // Device path matches this mapping's device prefix
      const relativePart = relativeDevicePath.slice(
        effectiveDevicePrefix.length + 1,
      );
      return normalizedLocalPrefix + "/" + relativePart;
    }
  }

  // No mapping matched, return as-is
  return relativeDevicePath;
}

/**
 * Get the effective device directory for a local relative path.
 * Useful for determining which directories need to be created on the device.
 */
export function getMappedDeviceDirectory(
  localRel: string,
  rootPath: string,
  mappings: PathMapping[] | undefined,
): string {
  const devicePath = applyPathMappings(localRel, rootPath, mappings);
  const dir = path.posix.dirname(devicePath);
  return dir === "." ? "/" : dir;
}

/**
 * Get all unique device directories that need to be created for a set of local files.
 */
export function getAllMappedDirectories(
  localFiles: string[],
  rootPath: string,
  mappings: PathMapping[] | undefined,
): string[] {
  const directories = new Set<string>();

  for (const localRel of localFiles) {
    const devicePath = applyPathMappings(localRel, rootPath, mappings);

    // Add all parent directories
    let currentDir = path.posix.dirname(devicePath);
    while (currentDir !== "/" && currentDir !== ".") {
      directories.add(currentDir);
      currentDir = path.posix.dirname(currentDir);
    }
  }

  // Sort by depth (shallowest first) for hierarchical creation
  return Array.from(directories).sort((a, b) => {
    const depthA = a.split("/").filter((p) => p).length;
    const depthB = b.split("/").filter((p) => p).length;
    return depthA - depthB;
  });
}
