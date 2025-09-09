# MPY Workbench — MicroPython file manager for VS Code

MPY Workbench provides fast, reliable two-way file sync and simple file management for MicroPython boards (ESP32 and similar) from inside Visual Studio Code.

Inspired by Thonny's simple functionality, this extension improves the workflow by adding effortless two-way sync between board and local files.

**⚡ Connect to board and run a file**
![Run file demo]([assets/run-file.gif](https://github.com/DanielBustillos/mpy-workbench/blob/main/assets/run-file.gif?raw=true)  

**🔄 Autosync local folder contents**
![Sync files demo](https://github.com/DanielBustillos/mpy-workbench/blob/main/assets/sync%20new%20files.gif?raw=true)  

## Main features

- 📂 Remote file explorer for the device (open, download, upload, rename, delete)  
- 🔄 Two-way sync: compare local files with the device and sync changed files  
- 📝 Create a new file in the Files view and upload it to the board on first save  
- 💻 Integrated MicroPython REPL terminal  
- ⚡ Per-workspace auto-sync and a status-bar indicator for workspace auto-sync  


## Sync utilities

These commands perform full or incremental synchronization between your local workspace and the connected MicroPython board. Short descriptions:


- **Check for differences**
  - Compares a local manifest and the board manifest to list changed/new files and deleted files on both sides. Local-only files (present locally but not on the board) are marked in the Files view.

- **Upload all files (Local → Board)** 
  - Upload every non-ignored file from the local workspace to the device, recreating the directory layout on the board. Use for a full deploy. Large or unwanted files will be skipped if they match ignore patterns.

- **Download all files (Board → Local)** 
  - Download every file from the device to the local workspace, overwriting local copies if present. Use to mirror the board's current state locally.


- **Sync changed files (Local → Board)** 
  - Uploads only files detected as changed or new on the local side. Directories are not uploaded; only files are transferred.

- **Sync changed files (Board → Local)**
  - Downloads only files detected as changed or new on the board side.

- **Delete all files on board**
  - Removes all files under the configured device root. This is destructive — the extension prompts for confirmation before running. Use with caution.


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

## Requirements

- Python 3 (used by helper scripts) and the `pyserial` package available to the Python interpreter used by VS Code
- A MicroPython build on your device (ESP32 builds are available at micropython.org)

## Troubleshooting

- If file operations fail, confirm the correct serial port is selected and that no other tool is holding the port open.
- If an upload fails because a path is a directory, the extension will skip directories and only upload files.

## Contributing

Issues and pull requests are welcome. See the repository for development and packaging notes.

## License

MIT — see the `LICENSE` file in this repository.
