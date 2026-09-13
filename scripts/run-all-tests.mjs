import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

// Códigos de color ANSI para terminal
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function logHeader(text) {
  console.log(`\n${colors.bold}${colors.cyan}================================================================${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}   ${text}${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}================================================================${colors.reset}\n`);
}

function runStage(stageNumber, totalStages, title, cwd, args) {
  return new Promise((resolve) => {
    console.log(`${colors.bold}${colors.blue}▶ [${stageNumber}/${totalStages}] ${title}...${colors.reset}`);
    const startTime = Date.now();

    const proc = spawn(npmCmd, args, {
      cwd: path.resolve(rootDir, cwd),
      stdio: 'inherit',
      shell: isWindows,
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    proc.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      if (code === 0) {
        console.log(`\n${colors.bold}${colors.green}✔ [${stageNumber}/${totalStages}] ${title} PASSED (${elapsed}s)${colors.reset}\n`);
        resolve({ ok: true, elapsed });
      } else {
        console.log(`\n${colors.bold}${colors.red}✖ [${stageNumber}/${totalStages}] ${title} FAILED with code ${code} (${elapsed}s)${colors.reset}\n`);
        resolve({ ok: false, elapsed, code });
      }
    });

    proc.on('error', (err) => {
      console.error(`\n${colors.bold}${colors.red}✖ Error launching process: ${err.message}${colors.reset}\n`);
      resolve({ ok: false, elapsed: 0, code: 1 });
    });
  });
}

async function main() {
  const globalStart = Date.now();

  logHeader('LIBSQLITE QUALITY GATE: VALIDACIÓN COMPLETA (BACKEND + FRONTEND)');

  const stages = [
    {
      title: 'Backend: Compilación TypeScript y Tests Unitarios/Integración',
      cwd: 'backend',
      args: ['test'],
    },
    {
      title: 'Frontend: Chequeo de Tipos y Compilación de Producción Next.js',
      cwd: 'frontend',
      args: ['test'],
    },
    {
      title: 'Storage & Engine: Smoke Tests de Runtime, WAL y Cifrado Ed25519',
      cwd: 'backend',
      args: ['run', 'test:runtime'],
    },
    {
      title: 'Networking & Gateway: Validación de URL Local y Subdominio Público con Token',
      cwd: 'backend',
      args: ['run', 'test:urls'],
    },
  ];

  const results = [];

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const res = await runStage(i + 1, stages.length, stage.title, stage.cwd, stage.args);
    results.push({ ...stage, ...res });

    if (!res.ok) {
      const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(2);
      console.log(`${colors.bold}${colors.red}================================================================${colors.reset}`);
      console.log(`${colors.bold}${colors.red} ❌ QUALITY GATE FALLÓ EN LA ETAPA [${i + 1}/${stages.length}]: ${stage.title}${colors.reset}`);
      console.log(`${colors.yellow} ⚠️  DESPLIEGUE ABORTADO: Corrige los errores anteriores antes de pasar a producción.${colors.reset}`);
      console.log(`${colors.gray} Tiempo transcurrido hasta el fallo: ${totalElapsed}s${colors.reset}`);
      console.log(`${colors.bold}${colors.red}================================================================${colors.reset}\n`);
      process.exit(1);
    }
  }

  const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(2);
  logHeader('RESUMEN DE VALIDACIÓN EXITOSA');

  results.forEach((r, idx) => {
    console.log(`  ${colors.green}✔ Etapa [${idx + 1}/${stages.length}]${colors.reset} ${r.title} ${colors.gray}(${r.elapsed}s)${colors.reset}`);
  });

  console.log(`\n${colors.bold}${colors.green}================================================================${colors.reset}`);
  console.log(`${colors.bold}${colors.green} ✅ TODAS LAS PRUEBAS (BACKEND + FRONTEND) HAN PASADO AL 100%.${colors.reset}`);
  console.log(`${colors.bold}${colors.green} 🚀 EL PROYECTO ESTÁ VERIFICADO Y APTO PARA DESPLIEGUE SEGURO.${colors.reset}`);
  console.log(`${colors.gray} Tiempo total de ejecución: ${totalElapsed}s${colors.reset}`);
  console.log(`${colors.bold}${colors.green}================================================================${colors.reset}\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
