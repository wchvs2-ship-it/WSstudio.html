import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const assetsDirectory = join(projectRoot, '.cloudflare', 'public');

// Esta lista também protege o pacote de publicação contra arquivos privados.
export const publicFiles = Object.freeze([
  'index.html',
  'app.js',
  'style.css',
  'catalog.js',
  'api-config.js',
  'admin/index.html',
  'admin/admin.js',
  'admin/admin.css',
]);

export async function buildAssets({ quiet = false } = {}) {
  // Valide tudo antes de substituir a última compilação.
  for (const relativePath of publicFiles) {
    const source = join(projectRoot, relativePath);
    if (!(await lstat(source)).isFile()) {
      throw new Error(`Arquivo público ausente ou inválido: ${relativePath}`);
    }
  }

  // Apague exclusivamente a pasta gerada de assets, nunca o repositório.
  await rm(assetsDirectory, { recursive: true, force: true });
  await mkdir(assetsDirectory, { recursive: true });
  for (const relativePath of publicFiles) {
    const destination = join(assetsDirectory, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(projectRoot, relativePath), destination);
  }

  if (!quiet) {
    process.stdout.write(`Assets públicos preparados: ${publicFiles.length} arquivos.\n`);
  }
  return assetsDirectory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildAssets();
  } catch (error) {
    process.stderr.write(`Falha ao preparar assets: ${error.message}\n`);
    process.exitCode = 1;
  }
}
