# Cambios

## [Unreleased]
### Seguridad
- **Inyección de comandos corregida**: Stop/Interrupt/Soft reset ejecutaban `echo -e ... > <puerto>` en un shell con el puerto sin escapar. Ahora se escribe directo al dispositivo serie (solo dispositivos de carácter) y todas las llamadas a mpremote usan `execFile` con lista de argumentos, sin shell.
- **Restricted Mode**: `mpyWorkbench.pythonPath`, `mpyWorkbench.connect` y `mpyWorkbench.rootPath` ya no se leen del workspace si no es de confianza (`restrictedConfigurations`). Igual para `python.defaultInterpreterPath`.

### Corregido
- **Windows**: los comandos usaban comillas POSIX, que cmd.exe y PowerShell no entienden. "Run file" ahora cita según el shell de la terminal (`&` en PowerShell) y el REPL lanza Python directamente, sin shell.
- **Menú contextual de Files**: Delete, Delete (board + local), Rename, New File, New Folder, Open local, Sync file ↔ board volvían a dar "command not found" (se habían desregistrado por error en 0.3.2).
- **Vista Local Files**: estaba implementada pero no declarada en `package.json`; ahora aparece con sus acciones (Upload to Board, Rename, Delete, etc.).
- **Bloqueo por puerto**: `markHealthy()` liberaba el bloqueo justo después de tomarlo, así que dos operaciones podían abrir el mismo puerto a la vez. Además, la espera ahora tiene un límite de 120 s en lugar de esperar para siempre.
- **Validación de mpremote**: se comprobaba un ejecutable `mpremote` en el PATH en lugar de `python -m mpremote`.
- **Instalación de mpremote**: usa `execFile` y reporta correctamente los fallos de pip.
- **Listado por raw REPL** (`usePyRawList`): apuntaba a un script inexistente (`thonny_list_files.py`); la ruta ahora se escapa con `repr()`.
- **REPL tras operaciones de archivos**: la terminal se recrea en lugar de enviar texto a un proceso terminado.

### Cambiado
- Logs en el canal de salida "MPY Workbench" (`MPY Workbench: Show Log`); los mensajes de depuración requieren `mpyWorkbench.debugLogging`.
- Mensajes de la UI unificados en inglés.
- Eliminado código sin uso: `boardOperations.ts`, `test.ts`, `mpremoteOperations.ts`, `monitor.ts`, `control.ts`, `miniterm_filter.py`, `scripts/check_python_deps.py`, `scripts/bench_upload.py`.
- `node_modules/`, `dist/` y el `.vsix` ya no se versionan; `vscode:prepublish` compila antes de empaquetar.
- Añadido `npm test` con tests unitarios del citado de comandos para terminal.

## [0.2.62] - 2026-02-08
### Mejorado
- **Usabilidad de errores al ejecutar (issue #14)**: Al usar "Run file", la extensión comprueba si el archivo existe en el board. Si existe, ejecuta con `mpremote exec "import <módulo>"` en lugar de `run`, de modo que los tracebacks muestran la ruta real del archivo (p. ej. `File "carpeta/archivo.py", line X`) y se puede hacer Ctrl+clic en VSCode para ir al código. Si el archivo no está en el board, se sigue usando `run` como antes.

### Cambiado
- **Etiquetas de la UI**: "Run Active File" → "Run file"; "Check for differences (local vs board)" → "Check for differences"; "Delete ALL files on Board" → "Clear Device Files"; menú "Sync Files" → "Sync utilities".

## [0.2.4] - 2025-09-13
### Cambiado
- **Migración de pyserial a mpremote**: Reemplazado el uso directo de pyserial con mpremote para todas las operaciones de comunicación serial
- **Validación de dependencias**: Actualizada la validación de Python para verificar disponibilidad de mpremote en lugar de pyserial
- **Scripts de utilidad**: Reemplazado `pyserial_tool.py` con `mpremote_tool.py` que usa comandos mpremote
- **Documentación**: Actualizadas las instrucciones de instalación y requisitos para usar mpremote

### Eliminado
- Dependencia directa de pyserial (mpremote incluye pyserial internamente)

## [0.2.0] - 2025-09-12
### Añadido
- **Integración completa con el intérprete Python de VS Code**: La extensión ahora usa automáticamente el intérprete Python configurado en VS Code en lugar de comandos hardcoded como `python3`
- **Soporte para entornos virtuales**: Compatibilidad completa con venv, conda, pyenv y otras configuraciones de Python
- **Configuración específica de Python**: Nueva opción `mpyWorkbench.pythonPath` para sobrescribir el intérprete Python específicamente para esta extensión
- **Sistema de fallback inteligente**: Detección automática de intérpretes Python con validación de dependencias (pyserial)
- **Cache inteligente**: Optimización de rendimiento con cache de 30 segundos que se actualiza automáticamente cuando cambian las configuraciones

### Mejorado
- **Compatibilidad multiplataforma**: Mejor manejo de rutas de Python en Windows, macOS y Linux
- **Gestión de errores**: Mensajes de error más claros cuando no se encuentra Python o pyserial
- **Performance**: Reducción de llamadas al sistema mediante cache inteligente
- **Terminal REPL**: Mejor integración con el intérprete Python configurado en terminales

### Cambiado
- **Comandos Python**: Todos los comandos que usaban `python3` hardcoded ahora usan el intérprete configurado en VS Code
- **Dependencias**: Validación automática de pyserial en el entorno Python correcto

## [0.0.1] - 2025-09-08
### Añadido
- Sincronización de archivos entre el sistema local y el ESP32.
- Exploración de archivos en el dispositivo.
- Apertura de terminales REPL y monitores seriales.
- Configuración para sincronización automática y rutas raíz.
