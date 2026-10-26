'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Lista explícita: novos arquivos de servidor nunca viram conteúdo público por
// terem uma extensão parecida com a de um arquivo do navegador.
const FRONTEND_FILES = Object.freeze([
  'index.html', 'admin.html', 'fiscal.html', 'privacidade.html',
  'styles.css', 'admin-orders.css', 'auth.css', 'interactions.css', 'fiscal.css', 'pix.css',
  'script.js', 'admin.js', 'auth.js', 'customer-utils.js', 'interactions.js',
  'supabase-config.js', 'fiscal.js', 'pix.js'
]);
const REQUIRED_FILES = Object.freeze(['fiscal.html', 'fiscal.css', 'fiscal.js', 'supabase-config.js']);
const IMAGE_EXTENSION = /\.(?:jpe?g|png|webp|gif|avif|svg|ico)$/i;

function statIfPresent(filename) {
  try { return fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function buildStatic(sourceDirectory = path.resolve(__dirname, '..')) {
  const source = fs.realpathSync(sourceDirectory);
  if (!fs.statSync(source).isDirectory()) throw new Error('A origem do build deve ser uma pasta.');
  const output = path.resolve(source, 'public');
  // O único alvo removível é o filho public/ da origem já resolvida. Nunca
  // seguimos links/junctions de saída para outra pasta.
  if (path.dirname(output) !== source || path.basename(output) !== 'public') {
    throw new Error('Pasta de saída fora da origem do build.');
  }
  const outputStat = statIfPresent(output);
  if (outputStat && (outputStat.isSymbolicLink() || !outputStat.isDirectory())) {
    throw new Error('public/ deve ser uma pasta comum gerada pelo build.');
  }

  const inputs = [];
  for (const filename of FRONTEND_FILES) {
    const candidate = path.join(source, filename);
    const info = statIfPresent(candidate);
    if (!info) {
      if (REQUIRED_FILES.includes(filename)) throw new Error(`Arquivo obrigatório ausente: ${filename}`);
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Arquivo público inválido: ${filename}`);
    inputs.push(filename);
  }

  const photos = path.join(source, 'Fotos');
  const photosStat = statIfPresent(photos);
  if (photosStat && (photosStat.isSymbolicLink() || !photosStat.isDirectory())) {
    throw new Error('Fotos/ deve ser uma pasta comum.');
  }
  function imageInputs(directory, relative) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const filename = path.join(directory, entry.name);
      const target = path.join(relative, entry.name);
      const info = fs.lstatSync(filename);
      if (info.isSymbolicLink()) throw new Error(`Links não são permitidos em Fotos/: ${target}`);
      if (info.isDirectory()) imageInputs(filename, target);
      else if (info.isFile() && IMAGE_EXTENSION.test(entry.name)) inputs.push(target);
    }
  }
  if (photosStat) imageInputs(photos, 'Fotos');

  // Todas as fontes foram verificadas antes de substituir a saída anterior.
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const filename of inputs) {
    const destination = path.join(output, filename);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, filename), destination);
  }
  return { output, files: inputs.map(filename => filename.split(path.sep).join('/')).sort(), photosMissing: !photosStat };
}

if (require.main === module) {
  const result = buildStatic();
  process.stdout.write(`Build estático: ${result.files.length} arquivos em public/.\n`);
  if (result.photosMissing) process.stderr.write('Fotos/ ausente neste checkout: nenhuma foto local foi incluída. O deploy deve usar o repositório completo para preservar essas imagens.\n');
}

module.exports = { buildStatic, FRONTEND_FILES, REQUIRED_FILES };
