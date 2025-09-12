# Python Interpreter Integration

This document describes how MPY Workbench integrates with VS Code's Python interpreter configuration.

## Overview

MPY Workbench now uses the Python interpreter configured in VS Code instead of hardcoded `python3` commands. This ensures compatibility with virtual environments, conda environments, and custom Python installations.

## Configuration Priority

The extension tries to find the Python interpreter in the following order:

1. **MPY Workbench Override** - `mpyWorkbench.pythonPath` setting
2. **Python Extension API** - Active interpreter from the Python extension
3. **Python Extension Settings** - `python.defaultInterpreterPath` or `python.pythonPath`
4. **System Fallbacks** - Common Python installation paths
5. **Last Resort** - `python3` command

## Configuration Options

### MPY Workbench Python Path Override

You can override the Python interpreter specifically for MPY Workbench:

```json
{
  "mpyWorkbench.pythonPath": "/path/to/your/python"
}
```

This setting takes precedence over all other Python configurations.

### Using VS Code's Python Configuration

The extension automatically uses the Python interpreter selected in VS Code:

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run "Python: Select Interpreter"
3. Choose your desired Python interpreter
4. MPY Workbench will automatically use this interpreter

## Features

### Automatic Cache Management

- Python interpreter path is cached for 30 seconds for performance
- Cache is automatically cleared when Python configuration changes
- Cache is cleared when the Python extension is activated/deactivated

### Fallback Support

If the configured Python interpreter is not available, the extension will:

1. Try other common Python installation paths
2. Validate each Python interpreter for required modules (pyserial)
3. Fall back to `python3` as a last resort

### Cross-Platform Support

The extension handles platform-specific Python installations:

**Windows:**
- `python`, `python3`, `py -3`, `py`
- Local AppData Python installations

**macOS/Linux:**
- `python3`, `python`
- Common system paths (`/usr/bin/python3`, `/usr/local/bin/python3`, etc.)
- Homebrew installations (`/opt/homebrew/bin/python3`)

## Updated Components

The following components now use the configured Python interpreter:

1. **Dependency Check** - Validates pyserial installation
2. **Serial Tool Execution** - All mpremote operations
3. **Raw Python Execution** - PyRaw directory listing
4. **Serial Monitor** - Terminal-based monitoring
5. **REPL Terminal** - ESP32 REPL connections

## Troubleshooting

### Python Not Found

If you see "Python not found" errors:

1. Ensure Python is installed and accessible
2. Install pyserial: `pip install pyserial`
3. Set `mpyWorkbench.pythonPath` to the correct Python path
4. Restart VS Code

### Virtual Environment Issues

If using virtual environments:

1. Activate your virtual environment
2. Select the interpreter in VS Code: "Python: Select Interpreter"
3. Ensure pyserial is installed in the virtual environment

### Permission Issues

On macOS/Linux, if you get permission errors:

1. Ensure your user has access to the serial port
2. Add your user to the dialout group: `sudo usermod -a -G dialout $USER`
3. Restart your session

## Migration from Hardcoded Python3

Existing installations will automatically migrate to use the configured Python interpreter. No manual changes are required.

The extension maintains backward compatibility and will fall back to `python3` if no other interpreter is found.