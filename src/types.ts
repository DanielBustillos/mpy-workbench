export type NodeKind = "file" | "dir";

export interface Esp32Node {
  kind: NodeKind;
  name: string; // basename
  path: string; // absolute on device, e.g. /, /lib, /main.py
  isLocalOnly?: boolean; // true if file exists locally but not on board
}
