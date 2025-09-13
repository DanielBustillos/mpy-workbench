#!/usr/bin/env node

// Script para probar manualmente la función checkDiffs
// Uso: node test_checkdiffs_manual.js [localPath] [localRelative] [boardPath] [rootPath]

const path = require('path');

// Función para convertir path local relativo a path del dispositivo
function toDevicePath(localRel, rootPath) {
  console.log(`[DEBUG] Converting local path ${localRel} to device path with rootPath ${rootPath}`);

  // Normalize paths
  const normalizedLocalPath = localRel.replace(/\/+/g, '/').replace(/\/$/, '');
  const normalizedRootPath = rootPath.replace(/\/+/g, '/').replace(/\/$/, '');

  console.log(`[DEBUG] Normalized paths - local: ${normalizedLocalPath}, root: ${normalizedRootPath}`);

  // If root is just "/", add leading slash to local path
  if (normalizedRootPath === "") {
    const result = "/" + normalizedLocalPath;
    console.log(`[DEBUG] Root is /, result: ${result}`);
    return result;
  }

  // If local path is empty, return root path
  if (normalizedLocalPath === "") {
    console.log(`[DEBUG] Local path is empty, result: ${normalizedRootPath}`);
    return normalizedRootPath;
  }

  // Combine root and local path
  const result = normalizedRootPath + "/" + normalizedLocalPath;
  console.log(`[DEBUG] Combined paths, result: ${result}`);
  return result;
}

// Función para convertir path del dispositivo a path local relativo
function relFromDevice(devicePath, rootPath) {
  console.log(`[DEBUG] Converting device path ${devicePath} with rootPath ${rootPath}`);

  // Normalize paths to ensure consistent comparison
  const normalizedDevicePath = devicePath.replace(/\/+/g, '/').replace(/\/$/, '');
  const normalizedRootPath = rootPath.replace(/\/+/g, '/').replace(/\/$/, '');

  console.log(`[DEBUG] Normalized paths - device: ${normalizedDevicePath}, root: ${normalizedRootPath}`);

  // If root is just "/", remove leading slash from device path
  if (normalizedRootPath === "") {
    const result = normalizedDevicePath.replace(/^\//, "");
    console.log(`[DEBUG] Root is /, result: ${result}`);
    return result;
  }

  // If device path starts with root path, remove the root prefix
  if (normalizedDevicePath.startsWith(normalizedRootPath + "/")) {
    const result = normalizedDevicePath.slice(normalizedRootPath.length + 1);
    console.log(`[DEBUG] Path starts with root, result: ${result}`);
    return result;
  }

  // If device path equals root path, return empty string
  if (normalizedDevicePath === normalizedRootPath) {
    console.log(`[DEBUG] Path equals root, result: ""`);
    return "";
  }

  // Fallback: remove leading slash if present
  const result = normalizedDevicePath.replace(/^\//, "");
  console.log(`[DEBUG] Fallback, result: ${result}`);
  return result;
}

// Función principal de simulación de checkDiffs
async function simulateCheckDiffs(localPath, localRelative, boardPath, rootPath) {
  console.log("=".repeat(60));
  console.log("SIMULACIÓN MANUAL DE checkDiffs");
  console.log("=".repeat(60));

  console.log("\n📁 DATOS DE ENTRADA:");
  console.log(`   Local Path: ${localPath}`);
  console.log(`   Local Relative: ${localRelative}`);
  console.log(`   Board Path: ${boardPath}`);
  console.log(`   Root Path: ${rootPath}`);

  console.log("\n🔍 INICIANDO COMPARACIÓN...");
  console.log("[DEBUG] checkDiffs: Starting diff check with tree cache");

  // Simular la lógica de comparación de archivos
  const localRel = localRelative;
  const abs = localPath;

  console.log(`[DEBUG] checkDiffs: Comparing local file: ${localRel}`);
  console.log(`[DEBUG] checkDiffs: Looking for device file with key: ${localRel}`);

  // Simular búsqueda del archivo en el dispositivo
  // En un escenario real, aquí se haría la llamada a mpremote
  const deviceFile = {
    path: boardPath,
    size: 1024, // Simular tamaño del archivo en el dispositivo
    isDir: false
  };

  console.log(`[DEBUG] checkDiffs: Device file found: ${!!deviceFile}`);

  if (deviceFile) {
    console.log(`[DEBUG] checkDiffs: ✓ MATCH FOUND - Local: ${localRel} -> Device: ${deviceFile.path}`);

    try {
      // Simular obtener el tamaño del archivo local
      // En un escenario real, aquí se usaría fs.stat()
      const st = { size: 1024 }; // Simular stat del archivo local

      console.log(`[DEBUG] checkDiffs: COMPARING - Local path: ${abs}, Board path: ${deviceFile.path}`);
      console.log(`[DEBUG] checkDiffs: Size comparison for ${localRel}: local=${st.size}, device=${deviceFile.size}, same=${st.size === deviceFile.size}`);

      if (st.size !== deviceFile.size) {
        console.log(`[DEBUG] checkDiffs: RESULT - DIFFERENT: Size mismatch for ${localRel}: local=${st.size}, device=${deviceFile.size}`);
        console.log("\n📋 RESULTADO FINAL:");
        console.log(`[DIFF-LOG] Local path: ${abs}`);
        console.log(`[DIFF-LOG] Board path searched: ${deviceFile.path}`);
        console.log(`[DIFF-LOG] Device file found: true`);
        console.log(`[DIFF-LOG] Result: MATCH FOUND - Local: ${localRel} -> Device: ${deviceFile.path}`);
        console.log(`[DIFF-LOG] Size comparison: local=${st.size} bytes, device=${deviceFile.size} bytes, same=false`);
        console.log(`[DIFF-LOG] Result: SIZE MISMATCH - File marked for sync`);
        console.log(`[DIFF-LOG] ---`);
      } else {
        console.log(`[DEBUG] checkDiffs: RESULT - SAME: File ${localRel} has same size on both local and board`);
        console.log("\n📋 RESULTADO FINAL:");
        console.log(`[DIFF-LOG] Local path: ${abs}`);
        console.log(`[DIFF-LOG] Board path searched: ${deviceFile.path}`);
        console.log(`[DIFF-LOG] Device file found: true`);
        console.log(`[DIFF-LOG] Result: MATCH FOUND - Local: ${localRel} -> Device: ${deviceFile.path}`);
        console.log(`[DIFF-LOG] Size comparison: local=${st.size} bytes, device=${deviceFile.size} bytes, same=true`);
        console.log(`[DIFF-LOG] Result: FILES IDENTICAL - No action needed`);
        console.log(`[DIFF-LOG] ---`);
      }
    } catch (error) {
      console.log(`[DEBUG] checkDiffs: ERROR - Local file not accessible: ${abs}, error: ${error}`);
      console.log("\n📋 RESULTADO FINAL:");
      console.log(`[DIFF-LOG] Local path: ${abs}`);
      console.log(`[DIFF-LOG] Board path searched: ${deviceFile.path}`);
      console.log(`[DIFF-LOG] Device file found: true`);
      console.log(`[DIFF-LOG] Result: LOCAL FILE NOT ACCESSIBLE - Error: ${error}`);
    }
  } else {
    console.log(`[DEBUG] checkDiffs: ✗ NO MATCH - Local: ${localRel} not found on device`);
    console.log("\n📋 RESULTADO FINAL:");
    console.log(`[DIFF-LOG] Local path: ${abs}`);
    console.log(`[DIFF-LOG] Board path searched: ${boardPath}`);
    console.log(`[DIFF-LOG] Device file found: false`);
    console.log(`[DIFF-LOG] Result: FILE MISSING ON BOARD - Will be marked as local-only`);
  }

  console.log("\n🔄 PRUEBAS DE CONVERSIÓN DE PATHS:");
  const devicePathFromLocal = toDevicePath(localRelative, rootPath);
  console.log(`toDevicePath("${localRelative}", "${rootPath}") = "${devicePathFromLocal}"`);

  const localRelativeFromDevice = relFromDevice(boardPath, rootPath);
  console.log(`relFromDevice("${boardPath}", "${rootPath}") = "${localRelativeFromDevice}"`);

  console.log("\n" + "=".repeat(60));
  console.log("SIMULACIÓN COMPLETADA");
  console.log("=".repeat(60));
}

// Función principal
function main() {
  // Obtener argumentos de línea de comandos
  const args = process.argv.slice(2);

  let localPath, localRelative, boardPath, rootPath;

  if (args.length >= 4) {
    // Usar argumentos proporcionados
    [localPath, localRelative, boardPath, rootPath] = args;
  } else {
    // Usar valores por defecto (los que proporcionó el usuario)
    localPath = "/Users/danielbustillos/Desktop/tmp/test-folder/test_inside_folder.py";
    localRelative = "test-folder/test_inside_folder.py";
    boardPath = "/test-folder/test_inside_folder.py";
    rootPath = "/";

    console.log("ℹ️  Usando valores por defecto. Para usar valores personalizados:");
    console.log("   node test_checkdiffs_manual.js [localPath] [localRelative] [boardPath] [rootPath]");
    console.log("");
  }

  // Ejecutar la simulación
  simulateCheckDiffs(localPath, localRelative, boardPath, rootPath).catch(console.error);
}

// Ejecutar si se llama directamente
if (require.main === module) {
  main();
}

module.exports = { simulateCheckDiffs, toDevicePath, relFromDevice };