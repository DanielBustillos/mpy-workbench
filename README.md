# MPY Workbench — MicroPython file manager for VS Code

MPY Workbench provides fast two-way file sync and simple file management for MicroPython boards (ESP32 and similar) from inside Visual Studio Code.

## Features

- File explorer for remote device files (list, open, upload, download, rename, delete)
- Two-way sync (Local ↔ Board), including a "check differences" workflow
- Optional auto-upload on save (workspace-level override stored in `.mpy-workbench/config.json`)
- Integrated REPL terminal and serial monitor
- Customizable settings (root path, serial options, auto-suspend behavior)

## Requirements

- Python 3 and the `pyserial` package available to the Python used by VS Code
- A MicroPython build on your device (ESP32 builds available at micropython.org)

## Quick start

1. Install the extension from the VS Code Marketplace or side-load the built `.vsix`.
2. Connect the device and select the serial port (Command Palette → "MPY Workbench: Select Serial Port").
3. Open the "MPY Workbench" view in the Activity Bar to browse files.

## Auto-sync on save

The global setting `mpyWorkbench.autoSyncOnSave` defaults to `false`. To enable auto-sync only for the current workspace create or toggle a per-workspace setting at `.mpy-workbench/config.json` (the extension provides the command "MPY Workbench: Toggle workspace Auto-Sync on Save"). The extension will consult that file first; if not present it falls back to the global setting.

## Commands (Command Palette)

- MPY Workbench: Refresh — refresh the file tree
- MPY Workbench: Check files differences — compare local and board files
- MPY Workbench: Sync changed Files (Local → Board)
- MPY Workbench: Sync changed Files (Board → Local)
- MPY Workbench: Sync all files — full upload or download
- MPY Workbench: Upload Active File — upload current editor file
- MPY Workbench: Select Serial Port — pick device port
- MPY Workbench: Open REPL Terminal — open MicroPython REPL

## Configuration

Most configuration is available under the `MPY Workbench` settings in VS Code. Important options:

- `mpyWorkbench.autoSyncOnSave` — global default for auto-upload-on-save (default: `false`)
- `mpyWorkbench.rootPath` — root path on the device (default: `/`)
- `mpyWorkbench.serialAutoSuspend` — close REPL before file ops (default: `true`)

## Contributing

Issues and pull requests are welcome. See the repository for development notes and packaging instructions.

## License

MIT — see the `LICENSE` file in this repository.

## Known issues

- Serial connections can be flaky: if an operation fails due to a transient serial error, retrying the command often succeeds. Ensure the correct serial port is selected and close other serial monitors if necessary.
