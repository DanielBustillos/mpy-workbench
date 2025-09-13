// Script de prueba para ejecutar la función checkDiffs con paths específicos
const path = require('path');
const fs = require('fs').promises;

// Simular las funciones necesarias
function toDevicePath(localRel: string, rootPath: string): string {
  console.log(`[DEBUG] checkDiffs: Converting local path ${localRel} to device path with rootPath ${rootPath}`);

  // Normalize paths
  const normalizedLocalPath = localRel.replace(/\/+/g, '/').replace(/\/$/, '');
  const normalizedRootPath = rootPath.replace(/\/+/g, '/').replace(/\/$/, '');

  console.log(`[DEBUG] checkDiffs: Normalized paths - local: ${normalizedLocalPath}, root: ${normalizedRootPath}`);

  // If root is just "/", add leading slash to local path
  if (normalizedRootPath === "") {
    const result = "/" + normalizedLocalPath;
    console.log(`[DEBUG] checkDiffs: Root is /, result: ${result}`);
    return result;
  }

  // If local path is empty, return root path
  if (normalizedLocalPath === "") {
    console.log(`[DEBUG] checkDiffs: Local path is empty, result: ${normalizedRootPath}`);
    return normalizedRootPath;
  }

  // Combine root and local path
  const result = normalizedRootPath + "/" + normalizedLocalPath;
  console.log(`[DEBUG] checkDiffs: Combined paths, result: ${result}`);
  return result;
}

function relFromDevice(devicePath: string, rootPath: string): string {
  console.log(`[DEBUG] checkDiffs: Converting device path ${devicePath} with rootPath ${rootPath}`);

  // Normalize paths to ensure consistent comparison
  const normalizedDevicePath = devicePath.replace(/\/+/g, '/').replace(/\/$/, '');
  const normalizedRootPath = rootPath.replace(/\/+/g, '/').replace(/\/$/, '');

  console.log(`[DEBUG] checkDiffs: Normalized paths - device: ${normalizedDevicePath}, root: ${normalizedRootPath}`);

  // If root is just "/", remove leading slash from device path
  if (normalizedRootPath === "") {
    const result = normalizedDevicePath.replace(/^\//, "");
    console.log(`[DEBUG] checkDiffs: Root is /, result: ${result}`);
    return result;
  }

  // If device path starts with root path, remove the root prefix
  if (normalizedDevicePath.startsWith(normalizedRootPath + "/")) {
    const result = normalizedDevicePath.slice(normalizedRootPath.length + 1);
    console.log(`[DEBUG] checkDiffs: Path starts with root, result: ${result}`);
    return result;
  }

  // If device path equals root path, return empty string
  if (normalizedDevicePath === normalizedRootPath) {
    console.log(`[DEBUG] checkDiffs: Path equals root, result: ""`);
    return "";
  }

  // Fallback: remove leading slash if present
  const result = normalizedDevicePath.replace(/^\//, "");
  console.log(`[DEBUG] checkDiffs: Fallback, result: ${result}`);
  return result;
}

// Función principal de prueba
async function testCheckDiffs() {
  console.log("[DEBUG] checkDiffs: Starting diff check with tree cache");

  const rootPath = "/";

  // Datos de prueba proporcionados por el usuario
  const testData = {
    localPath: "/Users/danielbustillos/Desktop/tmp/test-folder/test_inside_folder.py",
    localRelative: "test-folder/test_inside_folder.py",
    boardPath: "/test-folder/test_inside_folder.py"
  };

  console.log("=== TEST DATA ===");
  console.log("Local Path:", testData.localPath);
  console.log("Local Relative:", testData.localRelative);
  console.log("Board Path:", testData.boardPath);
  console.log("Root Path:", rootPath);
  console.log("=================");

  // Simular la lógica de comparación
  const localRel = testData.localRelative;
  const abs = testData.localPath;

  console.log(`[DEBUG] checkDiffs: Comparing local file: ${localRel}`);
  console.log(`[DEBUG] checkDiffs: Looking for device file with key: ${localRel}`);

  // Simular que encontramos el archivo en el dispositivo
  const deviceFile = {
    path: testData.boardPath,
    size: 1024, // Simular tamaño del archivo en el dispositivo
    isDir: false
  };

  console.log(`[DEBUG] checkDiffs: Device file found: ${!!deviceFile}`);

  if (deviceFile) {
    console.log(`[DEBUG] checkDiffs: ✓ MATCH FOUND - Local: ${localRel} -> Device: ${deviceFile.path}`);

    try {
      // Simular obtener el tamaño del archivo local
      const st = { size: 1024 }; // Simular stat del archivo local
      console.log(`[DEBUG] checkDiffs: COMPARING - Local path: ${abs}, Board path: ${deviceFile.path}`);
      console.log(`[DEBUG] checkDiffs: Size comparison for ${localRel}: local=${st.size}, device=${deviceFile.size}, same=${st.size === deviceFile.size}`);

      if (st.size !== deviceFile.size) {
        console.log(`[DEBUG] checkDiffs: RESULT - DIFFERENT: Size mismatch for ${localRel}: local=${st.size}, device=${deviceFile.size}`);
        console.log(`[DIFF-LOG] Local path: ${abs}`);
        console.log(`[DIFF-LOG] Board path searched: ${deviceFile.path}`);
        console.log(`[DIFF-LOG] Device file found: true`);
        console.log(`[DIFF-LOG] Result: MATCH FOUND - Local: ${localRel} -> Device: ${deviceFile.path}`);
        console.log(`[DIFF-LOG] Size comparison: local=${st.size} bytes, device=${deviceFile.size} bytes, same=false`);
        console.log(`[DIFF-LOG] Result: SIZE MISMATCH - File marked for sync`);
      } else {
        console.log(`[DEBUG] checkDiffs: RESULT - SAME: File ${localRel} has same size on both local and board`);
        console.log(`[DIFF-LOG] Local path: ${abs}`);
        console.log(`[DIFF-LOG] Board path searched: ${deviceFile.path}`);
        console.log(`[DIFF-LOG] Device file found: true`);
        console.log(`[DIFF-LOG] Result: MATCH FOUND - Local: ${localRel} -> Device: ${deviceFile.path}`);
        console.log(`[DIFF-LOG] Size comparison: local=${st.size} bytes, device=${deviceFile.size} bytes, same=true`);
        console.log(`[DIFF-LOG] Result: FILES IDENTICAL - No action needed`);
      }
    } catch (error) {
      console.log(`[DEBUG] checkDiffs: ERROR - Local file not accessible: ${abs}, error: ${error}`);
      console.log(`[DIFF-LOG] Local path: ${abs}`);
      console.log(`[DIFF-LOG] Board path searched: ${deviceFile.path}`);
      console.log(`[DIFF-LOG] Device file found: true`);
      console.log(`[DIFF-LOG] Result: LOCAL FILE NOT ACCESSIBLE - Error: ${error}`);
    }
  } else {
    console.log(`[DEBUG] checkDiffs: ✗ NO MATCH - Local: ${localRel} not found on device`);
    console.log(`[DIFF-LOG] Local path: ${abs}`);
    console.log(`[DIFF-LOG] Board path searched: ${testData.boardPath}`);
    console.log(`[DIFF-LOG] Device file found: false`);
    console.log(`[DIFF-LOG] Result: FILE MISSING ON BOARD - Will be marked as local-only`);
  }

  console.log(`[DIFF-LOG] ---`);

  // Probar las funciones de conversión de paths
  console.log("\n=== PATH CONVERSION TESTS ===");
  const devicePathFromLocal = toDevicePath(testData.localRelative, rootPath);
  console.log(`toDevicePath("${testData.localRelative}", "${rootPath}") = "${devicePathFromLocal}"`);

  const localRelativeFromDevice = relFromDevice(testData.boardPath, rootPath);
  console.log(`relFromDevice("${testData.boardPath}", "${rootPath}") = "${localRelativeFromDevice}"`);

  console.log("\n=== TEST COMPLETED ===");
}

// Ejecutar la prueba
testCheckDiffs().catch(console.error);