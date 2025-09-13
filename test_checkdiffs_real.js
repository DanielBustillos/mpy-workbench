#!/usr/bin/env node

// Script REAL para comparar archivos entre local y board usando mpremote
// Uso: node test_checkdiffs_real.js [localPath] [boardPath] [connectString]

const { execSync, spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

// Función para ejecutar mpremote y obtener información del archivo usando solo SHA256
async function getBoardFileInfo(boardPath, connectString = 'auto') {
  try {
    console.log(`[MPREMOTE] Ejecutando: mpremote connect ${connectString} fs sha256sum ${boardPath}`);

    // Ejecutar solo mpremote fs sha256sum
    const shaResult = execSync(`mpremote connect ${connectString} fs sha256sum ${boardPath}`, {
      encoding: 'utf8',
      timeout: 15000
    });

    console.log(`[AAAAAMPREMOTE] Resultado SHA256: ${shaResult.trim()}`);

    // Parsear la salida de mpremote fs sha256sum
    // Formato: "sha256sum :filename\nhash_value"
    const shaLines = shaResult.trim().split('\n');
    let sha256 = null;

    // Buscar la línea que contiene el hash (línea que no contiene "sha256sum")
    for (const line of shaLines) {
      if (!line.includes('sha256sum') && line.trim()) {
        // Esta línea debería contener solo el hash
        const hashMatch = line.trim().match(/^([a-f0-9]{64})$/);
        if (hashMatch) {
          sha256 = hashMatch[1];
          break;
        }
      }
    }

    if (sha256) {
      console.log(`[MPREMOTE] Archivo encontrado en board: ${boardPath}`);
      console.log(`[MPREMOTE] SHA256 checksum del board: ${sha256}`);

      return {
        exists: true,
        size: 0, // No obtenemos tamaño, solo checksum
        sha256: sha256,
        path: boardPath
      };
    } else {
      console.log(`[MPREMOTE] Error parseando SHA256 del board: ${shaResult}`);
      return { exists: false, size: 0, sha256: null, path: boardPath };
    }
  } catch (error) {
    console.log(`[MPREMOTE] Archivo NO encontrado en board: ${boardPath}`);
    console.log(`[MPREMOTE] Error: ${error.message}`);
    return { exists: false, size: 0, sha256: null, path: boardPath };
  }
}

// Función para obtener información del archivo local (tamaño + SHA256)
async function getLocalFileInfo(localPath) {
  try {
    const stats = await fs.stat(localPath);
    console.log(`[LOCAL] Archivo encontrado localmente: ${localPath}, tamaño: ${stats.size} bytes`);

    // Calcular SHA256 checksum usando shasum
    console.log(`[LOCAL] Ejecutando: shasum -a 256 "${localPath}"`);
    const shaResult = execSync(`shasum -a 256 "${localPath}"`, {
      encoding: 'utf8',
      timeout: 10000
    });

    // Parsear la salida de shasum
    // Formato típico: "hash_value  filename"
    const shaMatch = shaResult.trim().match(/^([a-f0-9]{64})\s+/);
    const sha256 = shaMatch ? shaMatch[1] : null;

    console.log(`[LOCAL] SHA256 checksum local: ${sha256 || 'No disponible'}`);

    return {
      exists: true,
      size: stats.size,
      sha256: sha256,
      path: localPath
    };
  } catch (error) {
    console.log(`[LOCAL] Archivo NO encontrado localmente: ${localPath}`);
    console.log(`[LOCAL] Error: ${error.message}`);
    return { exists: false, size: 0, sha256: null, path: localPath };
  }
}

// Función principal para comparar archivos
async function compareFiles(localPath, boardPath, connectString = 'auto') {
  console.log("=".repeat(80));
  console.log("🔍 COMPARACIÓN REAL DE ARCHIVOS: LOCAL vs BOARD");
  console.log("=".repeat(80));

  console.log(`\n📁 Parámetros:`);
  console.log(`   Local Path: ${localPath}`);
  console.log(`   Board Path: ${boardPath}`);
  console.log(`   Connect String: ${connectString}`);

  console.log(`\n🔍 OBTENIENDO INFORMACIÓN DE ARCHIVOS...`);

  // Obtener información de ambos archivos
  const [localInfo, boardInfo] = await Promise.all([
    getLocalFileInfo(localPath),
    getBoardFileInfo(boardPath, connectString)
  ]);

  console.log(`\n📊 RESULTADOS:`);
  console.log(`   Local: ${localInfo.exists ? '✅ Existe' : '❌ No existe'}`);
  console.log(`   Board: ${boardInfo.exists ? '✅ Existe' : '❌ No existe'}`);

  if (localInfo.exists && localInfo.sha256) {
    console.log(`   Local SHA256: ${localInfo.sha256}`);
  }
  if (boardInfo.exists && boardInfo.sha256) {
    console.log(`   Board SHA256: ${boardInfo.sha256}`);
  }

  // Logging detallado como en checkDiffs
  console.log(`\n📋 LOGGING DETALLADO ([DIFF-LOG]):`);
  console.log(`[DIFF-LOG] Local path: ${localPath}`);
  console.log(`[DIFF-LOG] Board path searched: ${boardPath}`);
  console.log(`[DIFF-LOG] Device file found: ${boardInfo.exists}`);

  if (!localInfo.exists && !boardInfo.exists) {
    console.log(`[DIFF-LOG] Result: FILES MISSING IN BOTH LOCATIONS`);
    console.log(`[DIFF-LOG] ---`);
    console.log(`\n❌ RESULTADO: Ambos archivos no existen`);
  } else if (!localInfo.exists) {
    console.log(`[DIFF-LOG] Result: FILE MISSING LOCALLY - Exists only on board`);
    console.log(`[DIFF-LOG] ---`);
    console.log(`\n⚠️  RESULTADO: Archivo existe solo en el board`);
  } else if (!boardInfo.exists) {
    console.log(`[DIFF-LOG] Result: FILE MISSING ON BOARD - Exists only locally`);
    console.log(`[DIFF-LOG] ---`);
    console.log(`\n⚠️  RESULTADO: Archivo existe solo localmente`);
  } else {
    // Ambos existen, comparar checksums SHA256
    console.log(`[DIFF-LOG] Result: MATCH FOUND - File exists in both locations`);

    // Comparar checksums si están disponibles
    let sha256Match = false;
    if (localInfo.sha256 && boardInfo.sha256) {
      sha256Match = localInfo.sha256 === boardInfo.sha256;
      console.log(`[DIFF-LOG] SHA256 comparison: local=${localInfo.sha256}, device=${boardInfo.sha256}, same=${sha256Match}`);
    } else {
      console.log(`[DIFF-LOG] SHA256 comparison: Not available (missing checksums)`);
    }

    if (sha256Match) {
      console.log(`[DIFF-LOG] Result: FILES IDENTICAL - No action needed`);
      console.log(`[DIFF-LOG] ---`);
      console.log(`\n✅ RESULTADO: Archivos idénticos (SHA256 match)`);
      console.log(`   Local: ${localInfo.sha256}`);
      console.log(`   Board: ${boardInfo.sha256}`);
    } else if (localInfo.sha256 && boardInfo.sha256) {
      // Diferentes checksums - archivos diferentes
      console.log(`[DIFF-LOG] Result: CONTENT MISMATCH - Different SHA256 checksums`);
      console.log(`[DIFF-LOG] ---`);
      console.log(`\n🔄 RESULTADO: Contenido diferente (diferentes checksums)`);
      console.log(`   Local SHA256: ${localInfo.sha256}`);
      console.log(`   Board SHA256: ${boardInfo.sha256}`);
      console.log(`   💡 Recomendación: Sincronizar el archivo más reciente`);
    } else {
      // No se pudieron obtener checksums
      console.log(`[DIFF-LOG] Result: CANNOT VERIFY CONTENT - SHA256 checksums not available`);
      console.log(`[DIFF-LOG] ---`);
      console.log(`\n⚠️  RESULTADO: No se puede verificar contenido (checksums no disponibles)`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("COMPARACIÓN COMPLETADA");
  console.log("=".repeat(80));

  // Determinar si los archivos son idénticos (comparando checksums si están disponibles)
  let areIdentical = false;
  if (localInfo.exists && boardInfo.exists) {
    if (localInfo.sha256 && boardInfo.sha256) {
      // Si tenemos checksums, usarlos para comparación precisa
      areIdentical = localInfo.sha256 === boardInfo.sha256;
    } else {
      // Fallback a comparación de tamaños si no hay checksums
      areIdentical = localInfo.size === boardInfo.size;
    }
  }

  return {
    localInfo,
    boardInfo,
    areIdentical: areIdentical,
    localOnly: localInfo.exists && !boardInfo.exists,
    boardOnly: !localInfo.exists && boardInfo.exists,
    bothMissing: !localInfo.exists && !boardInfo.exists,
    sha256Available: !!(localInfo.sha256 && boardInfo.sha256),
    sha256Match: localInfo.sha256 && boardInfo.sha256 ? localInfo.sha256 === boardInfo.sha256 : null
  };
}

// Función para probar múltiples archivos
async function testMultipleFiles(testCases) {
  console.log("🚀 INICIANDO PRUEBA MÚLTIPLE DE ARCHIVOS\n");

  for (const testCase of testCases) {
    console.log(`\n🎯 Probando: ${testCase.name}`);
    await compareFiles(testCase.localPath, testCase.boardPath, testCase.connectString);
    console.log(""); // Línea en blanco entre pruebas
  }
}

// Función principal
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // Modo interactivo con ejemplos
    console.log("🔧 MODO INTERACTIVO - Comparación Real con mpremote");
    console.log("=".repeat(60));
    console.log("\n📖 Uso:");
    console.log("  node test_checkdiffs_real.js [localPath] [boardPath] [connectString]");
    console.log("\n📝 Ejemplos:");
    console.log("  node test_checkdiffs_real.js '/home/user/main.py' '/main.py'");
    console.log("  node test_checkdiffs_real.js '/project/lib/utils.py' '/lib/utils.py' 'auto'");
    console.log("  node test_checkdiffs_real.js '/tmp/test.py' '/test.py' 'serial:///dev/ttyUSB0'");
    console.log("\n🎮 Ejecutando ejemplos de prueba...\n");

    // Ejecutar ejemplos de prueba
    const testCases = [
      {
        name: "Archivo en raíz",
        localPath: "/tmp/example_main.py",
        boardPath: "/main.py",
        connectString: "auto"
      },
      {
        name: "Archivo en subcarpeta",
        localPath: "/tmp/example_lib.py",
        boardPath: "/lib/example.py",
        connectString: "auto"
      }
    ];

    testMultipleFiles(testCases).catch(console.error);

  } else if (args.length >= 2) {
    // Modo con parámetros específicos
    const localPath = args[0];
    const boardPath = args[1];
    const connectString = args[2] || 'auto';

    console.log(`🔍 Comparando archivos:`);
    console.log(`   Local: ${localPath}`);
    console.log(`   Board: ${boardPath}`);
    console.log(`   Connect: ${connectString}`);
    console.log("");

    compareFiles(localPath, boardPath, connectString).catch(error => {
      console.error(`❌ Error durante la comparación: ${error.message}`);
      process.exit(1);
    });

  } else {
    console.log("❌ Error: Parámetros insuficientes");
    console.log("Uso: node test_checkdiffs_real.js [localPath] [boardPath] [connectString]");
    console.log("Ejemplo: node test_checkdiffs_real.js '/home/user/main.py' '/main.py' 'auto'");
    process.exit(1);
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  main();
}

module.exports = { compareFiles, getLocalFileInfo, getBoardFileInfo };