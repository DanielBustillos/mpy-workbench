# ESP32 Files Explorer (MicroPython)

## Description
The ESP32 Files Explorer extension for Visual Studio Code allows you to browse and manage files on ESP32 devices running MicroPython. It provides an intuitive interface for file synchronization, terminal access, and device management, making it easier to work with your ESP32 projects.

## Features
- **File Synchronization (Background Sync)**: Changes are synchronized seamlessly in the background, ensuring your files are always up to date both locally and on the ESP32 board. Modifications are first saved locally and luego sincronizados automáticamente con el dispositivo, sin interrumpir tu flujo de trabajo.
- **Reliable Two-Way Sync**: Any changes made on your computer or directly on el board se reflejan en ambos lados, evitando pérdidas de información.
- **Automatic Conflict Handling**: The extension maneja conflictos de archivos de manera inteligente, priorizando la versión más reciente y notificando al usuario si es necesario.
- **File Explorer**: Browse files on the ESP32 device directly from VS Code.
- **REPL Terminal**: Open a MicroPython REPL terminal for direct interaction with the device.
- **Serial Monitor**: Open a serial monitor to view device logs and debug output.
- **Customizable Settings**: Configure auto-sync, root paths, and other options to suit your workflow.

## Installation
1. Install the extension from the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/).
2. Ensure you have Python 3 and the `pyserial` library installed on your system.
3. Connect your ESP32 device to your computer via USB.


## Synchronization Details

The synchronization process is designed to be robust and transparent:

- **Background Operation**: File changes are detected y sincronizados automáticamente en segundo plano, sin necesidad de intervención manual.
- **Local and Board Consistency**: Cada vez que editas o guardas un archivo, los cambios se almacenan primero en tu sistema local y luego se sincronizan con el ESP32, garantizando que ambas ubicaciones estén siempre actualizadas.
- **Manual Sync Option**: Si lo prefieres, puedes forzar la sincronización en cualquier momento usando el comando `ESP32: Sync All Files`.
- **Conflict Resolution**: Si se detectan cambios simultáneos en local y en el board, la extensión te notificará para que elijas la versión correcta.

Estas funcionalidades aseguran que tu experiencia de desarrollo sea fluida, segura y sin preocupaciones respecto a la integridad de tus archivos.
### Command Palette
Access all commands via the Command Palette (`Cmd+Shift+P` or `Ctrl+Shift+P`):
- `ESP32: Refresh`: Refresh the file explorer.
- `ESP32: Open File`: Open a file from the ESP32 device.
- `ESP32: Upload Active File`: Upload the currently open file to the device.
- `ESP32: Select Serial Port`: Choose the serial port for communication.
- `ESP32: Open REPL Terminal`: Open a MicroPython REPL terminal.
- `ESP32: Sync All Files`: Sync all files between the local system and the device.

### File Explorer
- Navigate to the **ESP32 Files** view in the Activity Bar.
- Browse, upload, download, and delete files directly from the explorer.

### REPL and Serial Monitor
- Open a REPL terminal to interact with the MicroPython runtime.
- Use the serial monitor to view logs and debug output.

## Configuration
The extension provides several settings to customize its behavior:
- `esp32fs.autoSyncOnSave`: Automatically sync files to the device on save (default: `true`).
- `esp32fs.rootPath`: Set the root path to display on the device (default: `/`).
- `esp32fs.serialAutoSuspend`: Automatically close the REPL terminal before file operations (default: `true`).
- `esp32fs.interruptOnConnect`: Send a Ctrl-C command to interrupt running programs on REPL connect (default: `true`).

## Requirements
- Python 3 installed on your system.
- `pyserial` library installed (`pip install pyserial`).
- ESP32 device running MicroPython firmware.

## Contributing
Contributions are welcome! If you encounter issues or have feature requests, please open an issue or submit a pull request on the [GitHub repository](https://github.com/your-repo/esp32-files-explorer).

## License
This extension is licensed under the [MIT License](LICENSE).
