# Cambios

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
