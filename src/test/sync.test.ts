import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifest } from "../sync";
import { resolveSyncRoot, syncRelative } from "../syncRoot";

test("resolveSyncRoot defaults to the workspace and stays inside it", () => {
  const ws = path.resolve("/work/project");
  assert.equal(resolveSyncRoot(ws, ""), ws);
  assert.equal(resolveSyncRoot(ws, undefined), ws);
  assert.equal(resolveSyncRoot(ws, "."), ws);
  assert.equal(resolveSyncRoot(ws, "device"), path.join(ws, "device"));
  assert.equal(resolveSyncRoot(ws, "/device/"), path.join(ws, "device"));
  assert.equal(resolveSyncRoot(ws, "src\\board"), path.join(ws, "src", "board"));
  assert.throws(() => resolveSyncRoot(ws, "../other"));
  assert.throws(() => resolveSyncRoot(ws, "device/../../other"));
});

test("syncRelative returns posix paths and rejects files outside the root", () => {
  const root = path.resolve("/work/project/device");
  assert.equal(syncRelative(root, path.join(root, "lib", "x.py")), "lib/x.py");
  assert.equal(syncRelative(root, path.resolve("/work/project/README.md")), undefined);
  assert.equal(syncRelative(root, root), undefined);
});

test("buildManifest follows symlinks to files and folders without looping", { skip: process.platform === "win32" }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mpyw-"));
  try {
    const shared = path.join(tmp, "shared");
    const proj = path.join(tmp, "proj");
    await fs.mkdir(path.join(shared, "pkg"), { recursive: true });
    await fs.writeFile(path.join(shared, "lib.py"), "x = 1\n");
    await fs.writeFile(path.join(shared, "pkg", "mod.py"), "y = 2\n");
    await fs.mkdir(proj);
    await fs.writeFile(path.join(proj, "main.py"), "import lib\n");
    await fs.symlink(path.join(shared, "lib.py"), path.join(proj, "lib.py"));
    await fs.symlink(path.join(shared, "pkg"), path.join(proj, "pkg"));
    await fs.symlink(path.join(tmp, "missing.py"), path.join(proj, "broken.py"));
    await fs.symlink(proj, path.join(proj, "loop")); // must not recurse forever

    const m = await buildManifest(proj, () => false);
    assert.deepEqual(Object.keys(m.files).sort(), ["lib.py", "main.py", "pkg/mod.py"]);
    assert.equal(m.files["lib.py"].size, 6);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
