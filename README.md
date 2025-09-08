# ESP32 Files Explorer (MicroPython)

Browse, edit, and sync files on ESP32 boards running MicroPython directly from Visual Studio Code. Includes file explorer, REPL, serial monitor, and background synchronization.

---

## Features

- 📂 **File Explorer** – Browse, upload, download, and delete files on the ESP32.  
- 🔄 **Two-Way Sync** – Seamless background synchronization between local workspace and board.  
- ⚡ **Auto-Sync on Save** – Files are automatically synced when saved in VS Code.  
- 💻 **REPL Terminal** – Open a MicroPython REPL directly in VS Code.  
- 📡 **Serial Monitor** – Debug logs and output from your device.  
- ⚙️ **Custom Settings** – Configure sync behavior, root paths, and serial port options.  

---

## Requirements

- Python 3 installed on your system.  
- [`pyserial`](https://pypi.org/project/pyserial/) (`pip install pyserial`).  
- ESP32 device flashed with [MicroPython firmware](https://micropython.org/download/esp32/).  

---

## Installation

1. Install from the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/).  
2. Connect your ESP32 device via USB.  
3. Open the **ESP32 Files** view in the Activity Bar.  

---

## Usage

### Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
- `ESP32: Refresh` – Refresh file explorer.  
- `ESP32: Open File` – Open a file from the ESP32.  
- `ESP32: Upload Active File` – Upload the current file.  
- `ESP32: Sync All Files` – Force full sync.  
- `ESP32: Select Serial Port` – Choose port for communication.  
- `ESP32: Open REPL Terminal` – Start MicroPython REPL.  

### Explorer View
- Navigate to **ESP32 Files** in the Activity Bar.  
- Interact with files: upload, download, rename, delete.  

---

## Extension Settings

This extension contributes the following settings:

- `esp32fs.autoSyncOnSave`: Sync files on save (default: `true`).  
- `esp32fs.rootPath`: Root path on device (default: `/`).  
- `esp32fs.serialAutoSuspend`: Auto-close REPL before file ops (default: `true`).  
- `esp32fs.interruptOnConnect`: Send Ctrl-C on connect (default: `true`).  

---

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/your-repo/esp32-files-explorer).  

---

## License

[MIT](LICENSE)  
