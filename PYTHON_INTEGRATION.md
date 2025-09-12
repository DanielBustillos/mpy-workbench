# Python Interpreter Integration

This document describes how MPY Workbench integrates with VS Code's Python configuration to use the correct Python interpreter instead of hardcoded paths.

## Overview

MPY Workbench now automatically detects and uses the Python interpreter configured in VS Code, providing seamless integration with:

- VS Code's Python extension
- Virtual environments
- Conda environments
- System Python installations
- Custom Python installations

## How It Works

### 1. Python Interpreter Detection

The extension uses a multi-tier approach to find the correct Python interpreter:

1. **MPY Workbench Override** (`mpyWorkbench.pythonPath` setting)
   - If set, this takes highest priority
   - Allows users to specify a custom Python path for MPY Workbench specifically

2. **VS Code Python Extension API**
   - Queries the Python extension for the active interpreter
   - Supports both newer and older versions of the Python extension
   - Respects workspace-specific interpreter settings

3. **VS Code Configuration**
   - Falls back to `python.defaultInterpreterPath` (global setting)
   - Falls back to `python.pythonPath` (deprecated but still used)

4. **System Fallbacks**
   - `python3`, `python`, `/usr/bin/python3`, etc.
   - Platform-specific common installation paths

### 2. Caching and Performance

- Python interpreter path is cached for 30 seconds to improve performance
- Cache is automatically cleared when Python configuration changes
- Cache is cleared when the Python extension is activated/deactivated

### 3. Validation

Each detected Python interpreter is validated to ensure:
- The executable exists and is accessible
- It has the required `serial` module installed
- It can run basic Python commands

## Configuration

### Extension Settings

Add these to your VS Code `settings.json`:

```json
{
  "mpyWorkbench.pythonPath": "",
  "python.defaultInterpreterPath": "python3"
}
```

### Workspace-Specific Settings

For workspace-specific Python configuration:

```json
{
  "python.defaultInterpreterPath": "/path/to/venv/bin/python"
}
```

## Files Modified

The following files were updated to use the configured Python interpreter:

- `src/pythonInterpreter.ts` - New utility module for Python interpreter detection
- `src/extension.ts` - Updated dependency checks and terminal creation
- `src/mpremote.ts` - Updated tool execution
- `src/pyraw.ts` - Updated raw Python execution
- `src/monitor.ts` - Updated serial monitor
- `package.json` - Added Python path configuration setting

## Benefits

### ✅ Automatic Integration
- No manual configuration required in most cases
- Automatically uses the same Python environment as your projects

### ✅ Environment Support
- Works with virtual environments (`venv`, `virtualenv`)
- Supports Conda environments
- Compatible with Poetry, Pipenv, and other environment managers

### ✅ Flexibility
- Override option for specific use cases
- Graceful fallbacks when Python extension is not available
- Platform-independent implementation

### ✅ Performance
- Intelligent caching reduces filesystem operations
- Lazy loading of Python extension API
- Minimal impact on extension startup time

## Troubleshooting

### Python Not Found

If MPY Workbench cannot find a suitable Python interpreter:

1. **Check Python Extension**: Ensure the Python extension is installed and activated
2. **Configure Interpreter**: Use `Python: Select Interpreter` command in VS Code
3. **Manual Override**: Set `mpyWorkbench.pythonPath` in settings
4. **Install Dependencies**: Ensure `pyserial` is installed in the Python environment

### Common Issues

**Issue**: "Python interpreter not found"
**Solution**: Install Python and the Python extension, or set `mpyWorkbench.pythonPath`

**Issue**: "Serial module not found"
**Solution**: Install pyserial in the detected Python environment:
```bash
pip install pyserial
```

**Issue**: Wrong Python version being used
**Solution**: Check VS Code's Python interpreter selection or set `mpyWorkbench.pythonPath`

## Technical Details

### Python Extension API Compatibility

The implementation supports multiple versions of the Python extension:

- **Newer versions**: Uses `pythonApi.settings.getExecutionDetails()`
- **Older versions**: Uses `pythonApi.getActiveInterpreter()`
- **Fallback**: Uses VS Code configuration settings

### Platform Support

- **Windows**: Supports `python`, `python3`, `py -3`, and common installation paths
- **macOS**: Supports Homebrew, system Python, and custom installations
- **Linux**: Supports system Python, distro packages, and custom paths

### Error Handling

- Graceful degradation when Python extension is not available
- Clear error messages for troubleshooting
- Fallback chains prevent extension failure
- Validation prevents use of incompatible Python installations

## Migration Guide

### From Previous Versions

No action required! The extension automatically detects and uses your configured Python interpreter. Previous hardcoded `python3` usage is now dynamic.

### For Extension Developers

To use the configured Python interpreter in your code:

```typescript
import { getPythonPath, getPythonCommandForTerminal } from './pythonInterpreter';

// Get Python executable path
const pythonPath = await getPythonPath();

// Get Python command for terminal (handles quoting)
const pythonCmd = await getPythonCommandForTerminal();

// Use in execFile calls
execFile(pythonPath, ['-c', 'print("Hello")'], callback);

// Use in terminal commands
terminal.sendText(`${pythonCmd} -m serial.tools.miniterm ...`);
```

## Future Enhancements

Potential improvements for future versions:

- Support for Python environment discovery
- Integration with environment managers (Conda, Poetry, etc.)
- Automatic dependency installation
- Python version compatibility checking
- Enhanced error reporting and diagnostics

---

This integration ensures MPY Workbench seamlessly works with your Python development environment, providing a consistent and reliable experience across different setups and platforms.