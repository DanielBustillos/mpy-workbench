/**
 * Quoting helpers for commands typed into an integrated terminal.
 *
 * Child processes started by the extension itself must NOT use these helpers:
 * they are started with `execFile`/`spawn` and an argument array, which never
 * goes through a shell. These helpers exist only for text sent to a terminal
 * with `Terminal.sendText`, where a shell parses the line.
 *
 * This module has no dependency on `vscode` so it can be unit-tested with Node.
 */

export type ShellKind = "posix" | "powershell" | "cmd";

/** Guess the shell family from a shell executable path (e.g. `vscode.env.shell`). */
export function detectShellKind(shellPath: string | undefined, platform: NodeJS.Platform = process.platform): ShellKind {
  const base = (shellPath || "").replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (base.startsWith("pwsh") || base.startsWith("powershell")) return "powershell";
  if (base === "cmd" || base === "cmd.exe") return "cmd";
  if (base) return "posix"; // bash, zsh, fish, sh, Git Bash, WSL...
  // Unknown shell: fall back to the platform default.
  return platform === "win32" ? "powershell" : "posix";
}

export function quoteArg(arg: string, kind: ShellKind): string {
  switch (kind) {
    case "posix":
      // 'abc' ; embedded ' becomes '\''
      return `'${arg.replace(/'/g, "'\\''")}'`;
    case "powershell":
      // Single-quoted strings are literal in PowerShell; ' is escaped as ''
      return `'${arg.replace(/'/g, "''")}'`;
    case "cmd":
      // Double quotes; embedded " escaped with a backslash (MSVCRT argv rules).
      // Trailing backslashes must be doubled so they do not escape the closing quote.
      return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  }
}

/** Build a full command line: executable followed by its arguments, quoted for `kind`. */
export function buildCommandLine(executable: string, args: string[], kind: ShellKind): string {
  const exe = quoteArg(executable, kind);
  const rest = args.map(a => quoteArg(a, kind)).join(" ");
  // In PowerShell a quoted string at the start of a line is an expression, not a
  // command; the call operator `&` is required to execute it.
  const head = kind === "powershell" ? `& ${exe}` : exe;
  return rest ? `${head} ${rest}` : head;
}
