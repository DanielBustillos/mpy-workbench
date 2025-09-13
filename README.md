
# MPY Workbench — MicroPython file manager for VS Code

Inspired by Thonny’s simplicity, this extension streamlines MicroPython development across multiple boards. It provides remote file management, an integrated REPL, and automatic two-way synchronization, enabling a smoother workflow within VS Code.

The extension leverages **mpremote** for all board interactions, including file transfer, REPL connectivity, and command execution.

## Main features

- 📂 Remote file explorer for the device (open, download, upload, rename, delete)
- 🔄 Two-way sync: compare local files with the device and sync changed files
- 📝 Create a new file in the Files view and upload it to the board on first save
- 💻 Integrated MicroPython REPL terminal
- ⏯️ Send commands to the board (stop, soft reset, etc.)

**⚡ Connect to board and run a file**
![Run file demo](https://github.com/DanielBustillos/mpy-workbench/blob/main/assets/run-file.gif?raw=true)

**🔄 Autosync local folder contents**
![Sync files demo](https://github.com/DanielBustillos/mpy-workbench/blob/main/assets/sync%20new%20files.gif?raw=true)

## Sync utilities

These commands perform full or incremental synchronization between your local workspace and the connected MicroPython board:

- **Check for differences:** Lists new, changed, or deleted files between local and board.
- **Sync Local → Board:** Uploads only local files that are new or modified.
- **Sync Board → Local:** Downloads only board files that are new or modified.
- **Upload all Local → Board:** Uploads all non-ignored local files to the device.
- **Download all Board → Local:** Downloads all board files, overwriting local copies.
- **Delete all files on board:** Removes all files on the device.

## Useful commands (Command Palette)

- `MPY Workbench: Refresh` — refresh the file tree
- `MPY Workbench: Check files differences` — show diffs and local-only files
- `MPY Workbench: Sync changed Files (Local → Board)` — upload changed local files
- `MPY Workbench: Sync changed Files (Board → Local)` — download changed board files
- `MPY Workbench: Sync all files` — full upload or download
- `MPY Workbench: Upload Active File` — upload the current editor file
- `MPY Workbench: Select Serial Port` — pick device port
- `MPY Workbench: Open REPL Terminal` — open MicroPython REPL
- `MPY Workbench: Toggle workspace Auto-Sync on Save` — enable/disable workspace auto-sync

## Workspace config

The extension stores per-workspace settings and manifests inside a workspace folder named `.mpy-workbench` at your project root.

- Workspace override file: `.mpy-workbench/config.json`
- Sync manifest: `.mpy-workbench/esp32sync.json`

Use the command `MPY Workbench: Toggle workspace Auto-Sync on Save` to enable or disable auto-sync for the current workspace. If no workspace config exists the extension falls back to the global setting `mpyWorkbench.autoSyncOnSave` (default: `false`).

## Python Requirements

- **mpremote** — Used internally for all board operations (file management, REPL connection, command execution).

The Python path used by the extension can be adjusted in the extension settings if a specific interpreter needs to be selected.

## Next steps

- ✅ Broaden board compatibility (currently tested only with ESP32-S3 and ESP32-C3)
- 🔌 Add firmware flashing support for boards
- 🪟 Perform full Windows testing: validate mpremote compatibility with COM ports and ensure consistent behavior of file operations and REPL across Windows environments  

## Contributing

Issues and pull requests are welcome.

## License

MIT — see the `LICENSE` file in this repository.
