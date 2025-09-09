# Micropython File Explorer for Visual Studio Code

Inspired by Thonny's simple functionality, this extension improves the workflow by adding effortless two-way sync between board and local files.

Boost your ESP32 MicroPython development with seamless file management and instant synchronization. Edit, upload, and sync files effortlessly between your local workspace and ESP32 board—all within Visual Studio Code.

---

## Features

- 📂 **File Explorer** – Easily browse, upload, download, rename, and delete files on your ESP32.  
- 🔄 **Two-Way Sync** – Changes are synced instantly between your PC and device, speeding up development.  
- ⚡ **Auto-Sync on Save** – Save files locally and automatically update them on the ESP32.  
- 💻 **Integrated REPL Terminal** – Access the MicroPython REPL directly inside VS Code.  
- 📡 **Serial Monitor** – View device logs and output in real-time.  
- ⚙️ **Customizable Settings** – Tailor sync behavior, root paths, and serial port options to your workflow.  

---

## Requirements

- Python 3 installed on your system.  
- [`pyserial`](https://pypi.org/project/pyserial/) (`pip install pyserial`).  
- ESP32 board running [MicroPython firmware](https://micropython.org/download/esp32/).  

---

## Installation

1. Install **ESP32 Files Explorer** from the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/).  
2. Connect your ESP32 device via USB.  
3. Open the **ESP32 Files** view from the Activity Bar.  

---

## Usage

### Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)

- `ESP32: Refresh` – Refresh the file explorer view.  
- `ESP32: Open File` – Open files from the ESP32 board.  
- `ESP32: Upload Active File` – Upload the current file to the device.  
- `ESP32: Sync All Files` – Perform a full synchronization.  
- `ESP32: Select Serial Port` – Choose the communication port.  
- `ESP32: Open REPL Terminal` – Launch the MicroPython REPL.  

### Explorer View

- Manage files directly from the **ESP32 Files** panel: upload, download, rename, and delete.  

---

## Extension Settings

Configure the extension to fit your workflow:

- `esp32fs.autoSyncOnSave` (default: `true`) – Automatically sync files on save.  
- `esp32fs.rootPath` (default: `/`) – Root directory on the device.  
- `esp32fs.serialAutoSuspend` (default: `true`) – Auto-close REPL before file operations.  
- `esp32fs.interruptOnConnect` (default: `true`) – Send Ctrl-C on connection to interrupt running code.  

---

## Contributing

Contributions, issues, and feature requests are welcome! Visit the [GitHub repository](https://github.com/your-repo/esp32-files-explorer) to get involved.  

---

## License

[MIT License](LICENSE)
