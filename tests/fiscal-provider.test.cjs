'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BASES, FiscalError, readFiscalConfig, createFocusProvider, normalizeFocusResult, trustedDocumentUrl } = require('../lib/fiscal-provider.cjs');
const REF = 'jk' + '1'.repeat(32);
const CNPJ = '12345678000123';
const KEY = '1'.repeat(44);
function env(extra = {}) { return { FISCAL_ENABLED: 'true', FISCAL_ENVIRONMENT: 'homologacao', FOCUS_NFE_TOKEN: 'test-token',
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', ...extra }; }
const expected = { reference: REF, cnpj: CNPJ, environment: 'homologacao' };
function authorized(extra = {}) { return { data: { cnpj_emitente: CNPJ, ref: REF, status: 'autorizado', status_sefaz: '100',
  chave_nfe: 'NFe' + KEY, numero: '1', serie: '0', ...extra }, httpStatus: 200 }; }

test('opt-in fiscal exato; homologação é isolada e produção bloqueada em preview', () => {
  for (const extra of [{ FISCAL_ENABLED: 'false' }, { FISCAL_ENABLED: 'TRUE' }, { FISCAL_ENVIRONMENT: '' },
    { FOCUS_NFE_TOKEN: '' }, { FISCAL_ENVIRONMENT: 'constructor' }, { FISCAL_ENVIRONMENT: 'producao', VERCEL_ENV: 'preview' },
    { FISCAL_ENVIRONMENT: 'producao', VERCEL_ENV: 'development' }]) assert.throws(() => readFiscalConfig(env(extra)), { code: 'FISCAL_INDISPONIVEL' });
  assert.equal(readFiscalConfig(env({ VERCEL_ENV: 'preview' })).baseUrl, BASES.homologacao);
  assert.equal(readFiscalConfig(env({ FISCAL_ENVIRONMENT: 'producao', VERCEL_ENV: 'production' })).baseUrl, BASES.producao);
});

test('previsão funciona com emissão desativada e sem token, mas exige Supabase', () => {
  const config = readFiscalConfig(env({ FISCAL_ENABLED: 'false', FOCUS_NFE_TOKEN: '', FISCAL_ENVIRONMENT: '' }), { allowDisabled: true });
  assert.equal(config.enabled, false);
  assert.equal(config.environment, 'homologacao');
  assert.equal(config.environmentConfigured, false);
  assert.equal(config.token, null);
  assert.throws(() => readFiscalConfig(env({ SUPABASE_URL: 'http://example.test' }), { allowDisabled: true }));
});

test('Basic usa token: somente em host Focus fixo e rotas documentadas', async () => {
  const config = readFiscalConfig(env());
  const calls = [];
  const provider = createFocusProvider({ config, request: async (url, options) => { calls.push({ url, options }); return { status: 200, json: { status: 'processando_autorizacao' } }; } });
  await provider.get(REF);
  await provider.emit(REF, { cnpj_emitente: CNPJ, items: [] });
  await provider.cancel(REF, 'Cancelamento solicitado pelo cliente');
  assert.equal(calls[0].url, `${BASES.homologacao}/v2/nfe/${REF}?completa=1`);
  assert.equal(calls[1].url, `${BASES.homologacao}/v2/nfe?ref=${REF}`);
  assert.equal(calls[2].options.method, 'DELETE');
  assert.equal(JSON.parse(calls[2].options.body).justificativa, 'Cancelamento solicitado pelo cliente');
  for (const call of calls) assert.equal(call.options.headers.Authorization, 'Basic ' + Buffer.from('test-token:').toString('base64'));
  assert.throws(() => createFocusProvider({ config: { ...config, baseUrl: 'https://evil.test' } }));
  assert.throws(() => provider.cancel(REF, 'curta'), { code: 'FISCAL_VALIDACAO' });
});

test('404 consulta é ausência; redirects/erros não autorizam envio nem expõem resposta', async () => {
  const config = readFiscalConfig(env());
  const missing = createFocusProvider({ config, request: async () => ({ status: 404 }) });
  assert.equal(await missing.get(REF), null);
  for (const status of [301, 302, 401, 403, 500]) {
    const provider = createFocusProvider({ config, request: async () => ({ status, json: { token: 'leak' } }) });
    await assert.rejects(provider.get(REF), { code: 'FISCAL_EMISSOR_INDISPONIVEL' });
  }
});

test('autorização valida identidade e campos fiscais; 202 jamais é autorizada', () => {
  assert.equal(normalizeFocusResult(authorized(), expected).status, 'autorizada');
  assert.equal(normalizeFocusResult(authorized(), expected).result.chave, KEY);
  for (const extra of [{ ref: 'outra' }, { cnpj_emitente: '99999999000199' }, { chave_nfe: '' },
    { numero: '0' }, { serie: '1000' }, { status_sefaz: '999' }, { ambiente: '1' },
    { status: 'constructor' }, { protocolo_nota_fiscal: [] }, { requisicao_nota_fiscal: 'inválida' },
    { protocolo_nota_fiscal: { ambiente: '1' } }, { protocolo_nota_fiscal: { chave_nfe: '2'.repeat(44) } }]) assert.throws(() => normalizeFocusResult(authorized(extra), expected));
  assert.throws(() => normalizeFocusResult({ ...authorized(), httpStatus: 202 }, expected), { code: 'FISCAL_RESPOSTA_INVALIDA' });
  const processing = { data: { cnpj_emitente: CNPJ, ref: REF, status: 'processando_autorizacao' }, httpStatus: 202 };
  assert.equal(normalizeFocusResult(processing, expected).status, 'processando');
});

test('protocolo completo é opcional e validado quando fornecido', () => {
  const result = normalizeFocusResult(authorized({ protocolo_nota_fiscal: { ambiente: '2', status: '100', chave_nfe: KEY, numero_protocolo: '1'.repeat(15) } }), expected);
  assert.equal(result.result.protocolo, '1'.repeat(15));
  assert.throws(() => normalizeFocusResult(authorized({ protocolo_nota_fiscal: { numero_protocolo: 'inválido' } }), expected));
  const rejected = normalizeFocusResult({ data: { ref: REF, cnpj_emitente: CNPJ, status: 'erro_autorizacao', status_sefaz: '539', mensagem_sefaz: 'raw secret' }, httpStatus: 200 }, expected);
  assert.equal(rejected.status, 'rejeitada');
  assert.match(rejected.result.erro, /539/);
  assert.equal(JSON.stringify(rejected).includes('raw secret'), false);
});

test('documentos só no host do ambiente, sem redirects e sem vazar token', async () => {
  const config = readFiscalConfig(env());
  for (const path of ['https://evil.test/a.xml', '//evil.test/a.xml', `${BASES.producao}/arquivos/a.xml`,
    '/v2/empresas.xml', '/arquivos/a.html', 'https://user:pass@homologacao.focusnfe.com.br/arquivos/a.xml']) assert.throws(() => trustedDocumentUrl(path, config.baseUrl, 'xml'));
  const calls = [];
  const provider = createFocusProvider({ config, request: async (url, options) => { calls.push({ url, options }); return { status: 200, buffer: Buffer.from('<?xml version="1.0"?><nfeProc><NFe/></nfeProc>') }; } });
  assert.equal((await provider.document('/arquivos/test.xml', 'xml')).contentType, 'application/xml');
  assert.equal(calls[0].options.headers.Authorization, 'Basic ' + Buffer.from('test-token:').toString('base64'));
  const html = createFocusProvider({ config, request: async () => ({ status: 200, buffer: Buffer.from('<html>erro</html>') }) });
  await assert.rejects(html.document('/arquivos/test.xml', 'xml'), { code: 'FISCAL_DOCUMENTO_INVALIDO' });
  const redirected = createFocusProvider({ config, request: async () => ({ status: 302, buffer: Buffer.from('') }) });
  await assert.rejects(redirected.document('/arquivos/test.pdf', 'danfe'));
});
