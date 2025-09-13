
# MPY Workbench — MicroPython file manager for VS Code

Inspired by Thonny’s simplicity, this extension adds remote file management, integrated REPL, and effortless two-way sync, making it easy to develop MicroPython projects from VS Code.

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

MPY Workbench automatically uses the Python interpreter configured in VS Code. This ensures compatibility with virtual environments, conda environments, and custom Python installations.

## Troubleshooting

- If file operations fail, confirm the correct serial port is selected and that no other tool is holding the port open.
- If an upload fails because a path is a directory, the extension will skip directories and only upload files.

## Next steps

- ✅ Broaden board compatibility (currently tested only with ESP32-S3 and ESP32-C3)
- 🔌 Add firmware flashing support for boards
- 🎨 Improve REPL styling for better readability and usability

## Contributing

Issues and pull requests are welcome. See the repository for development and packaging notes.

## License

MIT — see the `LICENSE` file in this repository.
