import { runMpremote } from "./mpremote";

// Placeholder exports to make this a valid module
export async function ls(p: string): Promise<string> {
  return "";
}

export async function lsTyped(p: string): Promise<{ name: string; isDir: boolean }[]> {
  return [];
}

export async function listSerialPorts(): Promise<{port: string, name: string}[]> {
  return [];
}

export async function mkdir(p: string): Promise<void> {
  // Implementation
}

export async function cpFromDevice(devicePath: string, localPath: string): Promise<void> {
  // Implementation
}

export async function cpToDevice(localPath: string, devicePath: string): Promise<void> {
  // Implementation
}

export async function uploadReplacing(localPath: string, devicePath: string): Promise<void> {
  // Implementation
}

export async function deleteFile(p: string): Promise<void> {
  // Implementation
}

export async function deleteAny(p: string): Promise<void> {
  // Implementation
}

export async function deleteFolderRecursive(p: string): Promise<void> {
  // Implementation
}

export async function fileExists(p: string): Promise<boolean> {
  return false;
}

export async function getFileInfo(p: string): Promise<{mode: number, size: number, isDir: boolean, isReadonly: boolean} | null> {
  return null;
}

export async function deleteAllInPath(rootPath: string): Promise<{deleted: string[], errors: string[], deleted_count?: number, error_count?: number}> {
  return { deleted: [], errors: [], deleted_count: 0, error_count: 0 };
}

export async function runFile(localPath: string): Promise<{ stdout: string; stderr: string }> {
  return { stdout: "", stderr: "" };
}

export async function reset(): Promise<void> {
  // Implementation
}

export async function listTreeStats(root: string): Promise<Array<{ path: string; isDir: boolean; size: number; mtime: number }>> {
  return [];
}

export async function mvOnDevice(src: string, dst: string): Promise<void> {
  // Implementation
}

export function clearFileTreeCache(): void {
  // Implementation
}

export async function refreshFileTreeCache(): Promise<void> {
  // Implementation
}

export async function debugTreeParsing(): Promise<void> {
  // Implementation
}

export async function debugFilesystemStatus(): Promise<void> {
  // Implementation
}

export function getFileTreeCacheStats(): {
  isValid: boolean;
  age: number;
  itemCount: number;
  lastUpdate: number;
} {
  return {
    isValid: false,
    age: 0,
    itemCount: 0,
    lastUpdate: 0
  };
}