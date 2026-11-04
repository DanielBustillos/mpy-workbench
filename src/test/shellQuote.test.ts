import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildCommandLine, detectShellKind, quoteArg } from "../shellQuote";

test("detectShellKind recognizes common shells", () => {
  assert.equal(detectShellKind("/bin/bash"), "posix");
  assert.equal(detectShellKind("/usr/bin/zsh"), "posix");
  assert.equal(detectShellKind("C:\\Program Files\\Git\\bin\\bash.exe"), "posix");
  assert.equal(detectShellKind("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "powershell");
  assert.equal(detectShellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "powershell");
  assert.equal(detectShellKind("C:\\WINDOWS\\System32\\cmd.exe"), "cmd");
  assert.equal(detectShellKind(undefined, "win32"), "powershell");
  assert.equal(detectShellKind("", "linux"), "posix");
});

test("powershell command lines use the call operator", () => {
  assert.equal(
    buildCommandLine("C:\\Python 3\\python.exe", ["-m", "mpremote", "connect", "COM3"], "powershell"),
    "& 'C:\\Python 3\\python.exe' '-m' 'mpremote' 'connect' 'COM3'"
  );
  assert.equal(quoteArg("it's", "powershell"), "'it''s'");
});

test("cmd quoting escapes quotes and trailing backslashes", () => {
  assert.equal(quoteArg('a"b', "cmd"), '"a\\"b"');
  assert.equal(quoteArg("C:\\dir\\", "cmd"), '"C:\\dir\\\\"');
});

test("posix quoting round-trips through a real shell", { skip: process.platform === "win32" }, () => {
  const tricky = ["simple", "with space", "it's", "$(echo pwned)", "`id`", "a;b|c&d", "*.py", "line\nbreak", ""];
  const line = buildCommandLine("printf", ["%s\\0", ...tricky], "posix");
  const out = execFileSync("/bin/sh", ["-c", line], { encoding: "utf8" });
  assert.deepEqual(out.split("\0").slice(0, -1), tricky);
});
