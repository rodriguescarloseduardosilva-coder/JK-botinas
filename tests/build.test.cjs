'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildStatic, FRONTEND_FILES, REQUIRED_FILES } = require('../scripts/build.cjs');

function fixture(action) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'jk-fiscal-build-'));
  try { return action(root); }
  finally {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('jk-fiscal-build-')) {
      throw new Error('Pasta temporária fora do alvo esperado.');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
function write(root, filename, contents = 'fixture') {
  const target = path.join(root, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}
function files(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    return entry.isDirectory() ? files(path.join(root, entry.name), relative + '/') : [relative];
  }).sort();
}

test('build publica somente frontend conhecido e imagens, preservando API/lib privadas', () => fixture(root => {
  for (const filename of FRONTEND_FILES) write(root, filename, `frontend: ${filename}`);
  for (const filename of ['api/fiscal.js', 'lib/fiscal-provider.cjs', 'tests/private.test.cjs',
    'supabase/migrations/private.sql', 'FISCAL.md', '.env', 'package.json', 'node_modules/private.js',
    'server-secret.js', 'certificado.pfx', 'public/stale-private.sql']) write(root, filename, 'PRIVATE_SENTINEL');
  write(root, 'Fotos/Botina 01.JPG', 'image fixture');
  write(root, 'Fotos/catalogo/botina.webp', 'image fixture');
  for (const filename of ['Fotos/private.sql', 'Fotos/server.js', 'Fotos/page.html', 'Fotos/.env', 'Fotos/.oculta/private.png']) write(root, filename, 'PRIVATE_SENTINEL');
  const result = buildStatic(root);
  const expected = [...FRONTEND_FILES, 'Fotos/Botina 01.JPG', 'Fotos/catalogo/botina.webp'].sort();
  assert.deepEqual(files(result.output), expected);
  assert.deepEqual(result.files, expected);
  assert.equal(result.photosMissing, false);
  assert.equal(fs.readFileSync(path.join(root, 'api/fiscal.js'), 'utf8'), 'PRIVATE_SENTINEL');
  assert.equal(fs.readFileSync(path.join(root, 'lib/fiscal-provider.cjs'), 'utf8'), 'PRIVATE_SENTINEL');
  for (const filename of result.files) assert.equal(fs.readFileSync(path.join(result.output, filename), 'utf8').includes('PRIVATE_SENTINEL'), false);
}));

test('checkout parcial gera painel fiscal e informa ausência de Fotos sem copiar outros arquivos', () => fixture(root => {
  for (const filename of REQUIRED_FILES) write(root, filename);
  write(root, 'lib/private.js', 'PRIVATE_SENTINEL');
  const result = buildStatic(root);
  assert.equal(result.photosMissing, true);
  assert.deepEqual(files(result.output), [...REQUIRED_FILES].sort());
}));

test('build inválido preserva a saída anterior em vez de publicar pacote incompleto', () => fixture(root => {
  for (const filename of REQUIRED_FILES.filter(filename => filename !== 'fiscal.js')) write(root, filename);
  write(root, 'public/previous.html', 'previous build');
  assert.throws(() => buildStatic(root), /Arquivo obrigatório ausente: fiscal\.js/);
  assert.deepEqual(files(path.join(root, 'public')), ['previous.html']);
}));
