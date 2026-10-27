'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFiscalHandler, createFiscalStore } = require('../lib/fiscal-handler.cjs');
const { FiscalError, BASES } = require('../lib/fiscal-provider.cjs');
const ID = '11111111-1111-1111-1111-111111111111';
const REF = 'jk' + ID.replaceAll('-', '');
const CNPJ = '12345678000123';
const KEY = '1'.repeat(44);
const NOW = new Date('2026-10-26T18:00:00.000Z');
function draft() { return { config_versao: 1,
  destinatario: { nome: 'Cliente teste', tipo_documento: 'cpf', documento: '12345678901', indicador_ie: 9,
    logradouro: 'Rua Cliente', numero: '1', bairro: 'Centro', municipio: 'Brasilia', codigo_municipio: '5300108', uf: 'DF', cep: '70000000' },
  itens: [{ codigo: 'TESTE', descricao: 'Teste de integração', unidade: 'PAR', quantidade: '1', preco_unitario: '100', perfil_id: 'teste' }],
  frete: '0', desconto: '0', natureza_operacao: 'Venda', presenca_comprador: 1, consumidor_final: 1,
  pagamento: { forma: '01', indicador_pagamento: 0 }, campos_adicionais: {} }; }
function fiscalConfig() { return { versao: 1, dados: { emitente: { cnpj: CNPJ, nome: 'Empresa teste', inscricao_estadual: '12345678',
  logradouro: 'Rua Emitente', numero: '1', bairro: 'Centro', municipio: 'Brasilia', uf: 'DF', cep: '70000000', regime_tributario: 1 },
  perfis: [{ id: 'teste', nome: 'Perfil de teste de software', uf_destino: ['DF'], tipo_documento: ['cpf'], presenca_comprador: [1,2,3,9],
    campos_fiscais: { codigo_ncm: '64039990', cfop: '5102', icms_origem: 0, icms_situacao_tributaria: '102', pis_situacao_tributaria: '07', cofins_situacao_tributaria: '07' } }],
  campos_adicionais: { finalidade_emissao: 1, modalidade_frete: 9 } } }; }
function note(extra = {}) { return { id: ID, referencia: REF, status: 'rascunho', versao: 1, dados: draft(), ambiente: null, snapshot: null, documentos: {}, ...extra }; }
function authorized(extra = {}) { return { data: { cnpj_emitente: CNPJ, ref: REF, status: 'autorizado', status_sefaz: '100', chave_nfe: KEY, numero: '1', serie: '1',
  caminho_xml_nota_fiscal: '/arquivos/test.xml', caminho_danfe: '/arquivos/test.pdf', ...extra }, httpStatus: 200 }; }
function fixture({ enabled = true, initial = note(), environment = 'homologacao' } = {}) {
  let saved = structuredClone(initial);
  let currentFocus = null;
  const calls = [];
  const configRow = fiscalConfig();
  const settings = { environment, enabled, environmentConfigured: true, baseUrl: BASES[environment], token: 'server-secret' };
  const store = {
    async authenticate(token) { calls.push(['auth', token]); if (token !== 'valid') throw new FiscalError('FISCAL_NAO_AUTORIZADO', 401); return { id: ID, app_metadata: { loja_admin: true } }; },
    async isAdmin() { calls.push(['admin']); return true; },
    async getNote() { calls.push(['note']); return saved && structuredClone(saved); },
    async getConfig() { calls.push(['config']); return structuredClone(configRow); },
    async reserve(args) {
      calls.push(['reserve', structuredClone(args)]);
      if (['enviando','processando','autorizada','cancelada'].includes(saved.status)) return { ...structuredClone(saved), pode_enviar: false };
      if (saved.versao !== args.p_versao) throw new FiscalError('FISCAL_CONFLITO', 409);
      saved = { ...saved, snapshot: structuredClone(args.p_payload), ambiente: args.p_ambiente, status: 'enviando', versao: saved.versao + 1 };
      return { ...structuredClone(saved), pode_enviar: true };
    },
    async register(args) {
      calls.push(['register', structuredClone(args)]);
      if (saved.versao !== args.p_versao || saved.referencia !== args.p_referencia || saved.ambiente !== args.p_ambiente) throw new FiscalError('FISCAL_CONFLITO', 409);
      if (saved.status === 'cancelada' && args.p_status !== 'cancelada') return structuredClone(saved);
      if (saved.status === 'autorizada' && !['autorizada','cancelada'].includes(args.p_status)) return structuredClone(saved);
      saved = { ...saved, status: args.p_status, ...structuredClone(args.p_resultado) };
      return structuredClone(saved);
    }
  };
  const provider = {
    async get(ref) { calls.push(['focusGet', ref]); return currentFocus && structuredClone(currentFocus); },
    async emit(ref, payload) {
      calls.push(['focusPost', ref, structuredClone(payload)]);
      currentFocus = { data: { ref, cnpj_emitente: payload.cnpj_emitente, status: 'processando_autorizacao', requisicao_nota_fiscal: structuredClone(payload) }, httpStatus: 202 };
      return structuredClone(currentFocus);
    },
    async cancel(ref) { calls.push(['focusDelete', ref]); currentFocus = authorized({ status: 'cancelado', status_sefaz: '135' }); return { data: { status: 'cancelado', status_sefaz: '135' }, httpStatus: 200 }; },
    async document(path, type) { calls.push(['document', path, type]); return { buffer: Buffer.from(type === 'xml' ? '<nfeProc><NFe/></nfeProc>' : '%PDF-1.4\nTEST'), contentType: type === 'xml' ? 'application/xml' : 'application/pdf' }; }
  };
  const handler = createFiscalHandler({ config: settings, store, provider, now: () => NOW });
  return { handler, calls, store, provider, settings, configRow, row: () => saved, setRow: value => { saved = structuredClone(value); }, setFocus: value => { currentFocus = structuredClone(value); } };
}
async function invoke(handler, action = 'emitir', extra = {}, headers = { authorization: 'Bearer valid' }, method = 'POST') {
  const body = { acao: action, id: ID, ...(action === 'emitir' ? { versao: 1, ambiente: 'homologacao' } : {}), ...extra };
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { if (Buffer.isBuffer(value)) this.buffer = value; else this.json = JSON.parse(value); } };
  await handler({ method, headers, body }, response);
  return response;
}

test('prever autenticado funciona sem token/ativação e não reserva nem chama Focus', async () => {
  const f = fixture({ enabled: false });
  const response = await invoke(f.handler, 'prever');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.total, '100.00');
  assert.equal(response.json.habilitado, false);
  assert.equal(response.json.ambiente, 'homologacao');
  assert.equal(f.calls.some(c => c[0] === 'reserve' || c[0].startsWith('focus')), false);
  const blocked = await invoke(f.handler);
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json.code, 'FISCAL_INDISPONIVEL');
});

test('exige autenticação, app_metadata admin e autorização SQL antes da nota', async () => {
  const f = fixture();
  assert.equal((await invoke(f.handler, 'prever', {}, { authorization: 'Bearer invalid' })).statusCode, 401);
  assert.equal(f.calls.some(c => c[0] === 'note'), false);
  f.store.authenticate = async () => ({ id: ID, app_metadata: { loja_admin: false } });
  assert.equal((await invoke(f.handler, 'prever')).statusCode, 403);
  f.store.authenticate = async () => ({ id: ID, app_metadata: { loja_admin: true } }); f.store.isAdmin = async () => false;
  assert.equal((await invoke(f.handler, 'prever')).statusCode, 403);
  assert.equal(f.calls.some(c => c[0] === 'note'), false);
});

test('recusa dados do cliente, origem externa, ambiente alterado e configuração desatualizada', async () => {
  const f = fixture();
  assert.equal((await invoke(f.handler, 'emitir', { payload: { valor_total: '0.01' } })).statusCode, 400);
  assert.equal((await invoke(f.handler, 'prever', {}, { authorization: 'Bearer valid', origin: 'https://evil.test', host: 'loja.test' })).statusCode, 403);
  assert.equal((await invoke(f.handler, 'emitir', { ambiente: 'producao' })).json.code, 'FISCAL_AMBIENTE_ALTERADO');
  f.configRow.versao = 2;
  assert.equal((await invoke(f.handler, 'prever')).json.code, 'FISCAL_CONFIG_ALTERADA');
  assert.equal(f.calls.some(c => c[0].startsWith('focus') || c[0] === 'reserve'), false);
});

test('emissão lê total do servidor, GET antes POST, usa versão reservada e 202 é processando', async () => {
  const f = fixture();
  const response = await invoke(f.handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.status, 'processando');
  assert.equal(response.json.versao, 2);
  const sent = f.calls.find(c => c[0] === 'focusPost');
  assert.equal(sent[1], REF);
  assert.equal(sent[2].valor_total, '100.00');
  assert.deepEqual(f.calls.filter(c => ['focusGet','reserve','focusPost','register'].includes(c[0])).map(c => c[0]), ['focusGet','reserve','focusPost','register']);
  assert.equal(f.calls.find(c => c[0] === 'register')[1].p_versao, 2);
  assert.equal(JSON.stringify(response.json).includes('server-secret'), false);
  assert.equal(JSON.stringify(response.json).includes('cnpj_emitente'), false);
});

test('repetição e concorrência não criam uma segunda emissão', async () => {
  const f = fixture();
  const responses = await Promise.all([invoke(f.handler), invoke(f.handler)]);
  assert.ok(responses.some(r => r.statusCode === 200));
  await invoke(f.handler);
  assert.equal(f.calls.filter(c => c[0] === 'focusPost').length, 1);
  assert.equal(f.row().referencia, REF);
  assert.equal(f.row().versao, 2);
});

test('GET falho antes da reserva não altera rascunho nem envia', async () => {
  const f = fixture(); f.provider.get = async () => { throw new FiscalError('FISCAL_EMISSOR_INDISPONIVEL'); };
  assert.equal((await invoke(f.handler)).statusCode, 502);
  assert.equal(f.row().status, 'rascunho');
  assert.equal(f.calls.some(c => c[0] === 'reserve' || c[0] === 'focusPost'), false);
});

test('timeout POST recupera por GET da mesma referência sem outra emissão', async () => {
  const f = fixture();
  f.provider.emit = async ref => { f.calls.push(['focusPost', ref]); f.setFocus(authorized()); throw new FiscalError('FISCAL_EMISSOR_INDISPONIVEL'); };
  const response = await invoke(f.handler);
  assert.equal(response.json.status, 'autorizada');
  assert.equal(f.calls.filter(c => c[0] === 'focusPost').length, 1);
  assert.deepEqual(f.calls.filter(c => c[0] === 'focusGet').map(c => c[1]), [REF, REF]);
  assert.equal(response.json.documentos.xml, true);
  assert.equal(JSON.stringify(response.json).includes('focusnfe.com.br'), false);
});

test('timeout ou HTTP não comprovado com GET404 mantém snapshot travado', async () => {
  for (const code of ['FISCAL_EMISSOR_INDISPONIVEL', 'FISCAL_REJEITADA']) {
    const f = fixture(); f.provider.emit = async () => { throw new FiscalError(code, 422); };
    const response = await invoke(f.handler);
    assert.equal(response.json.code, 'FISCAL_ENVIO_INDEFINIDO');
    assert.equal(f.row().status, 'enviando');
    assert.equal(f.row().snapshot.valor_total, '100.00');
    assert.equal(f.calls.some(c => c[0] === 'register'), false);
    assert.equal((await invoke(f.handler)).json.code, 'FISCAL_ENVIO_INDEFINIDO');
  }
});

test('rejeição explícita do POST libera correção, mas reenviar exige salvar rascunho', async () => {
  const f = fixture();
  f.provider.emit = async () => ({ data: { cnpj_emitente: CNPJ, ref: REF, status: 'erro_autorizacao', status_sefaz: '539' }, httpStatus: 200 });
  assert.equal((await invoke(f.handler)).json.status, 'rejeitada');
  assert.equal((await invoke(f.handler, 'emitir', { versao: 2 })).json.code, 'FISCAL_ESTADO_INVALIDO');
});

test('GET rejeitado antigo nunca libera nova tentativa em andamento', async () => {
  const f = fixture(); await invoke(f.handler);
  f.setFocus({ data: { cnpj_emitente: CNPJ, ref: REF, status: 'erro_autorizacao',
    requisicao_nota_fiscal: { ...f.row().snapshot, data_emissao: '2026-10-25T18:00:00Z' } }, httpStatus: 200 });
  const response = await invoke(f.handler, 'consultar');
  assert.equal(response.json.code, 'FISCAL_ENVIO_INDEFINIDO');
  assert.equal(f.row().status, 'processando');
  assert.equal(f.calls.filter(c => c[0] === 'focusPost').length, 1);
});

test('reenvio de rascunho corrigido exige evidência completa da rejeição anterior', async () => {
  const oldSnapshot = { cnpj_emitente: CNPJ, data_emissao: '2026-10-25T18:00:00Z', valor_total: '100.00' };
  const f = fixture({ initial: note({ snapshot: oldSnapshot, ambiente: 'homologacao', versao: 4 }) });
  f.setFocus({ data: { cnpj_emitente: CNPJ, ref: REF, status: 'erro_autorizacao' }, httpStatus: 200 });
  assert.equal((await invoke(f.handler, 'emitir', { versao: 4 })).json.code, 'FISCAL_ENVIO_INDEFINIDO');
  assert.equal(f.calls.some(c => c[0] === 'reserve'), false);
  f.setFocus({ data: { cnpj_emitente: CNPJ, ref: REF, status: 'erro_autorizacao', requisicao_nota_fiscal: oldSnapshot }, httpStatus: 200 });
  const response = await invoke(f.handler, 'emitir', { versao: 4 });
  assert.equal(response.json.status, 'processando');
  assert.equal(f.row().versao, 5);
});

test('retorno autorizado inconsistente não grava autorização', async () => {
  const f = fixture(); f.provider.emit = async () => authorized({ cnpj_emitente: '99999999000199' });
  assert.equal((await invoke(f.handler)).json.code, 'FISCAL_RESPOSTA_DIVERGENTE');
  assert.equal(f.row().status, 'enviando');
  assert.equal(f.calls.some(c => c[0] === 'register'), false);
});

test('cancelamento usa consulta antes e depois do DELETE; documento é proxy autenticado', async () => {
  const f = fixture(); await invoke(f.handler); f.setFocus(authorized());
  const cancel = await invoke(f.handler, 'cancelar', { justificativa: 'Cliente solicitou cancelamento da venda' });
  assert.equal(cancel.json.status, 'cancelada');
  const flow = f.calls.filter(c => ['focusGet','focusDelete'].includes(c[0])).map(c => c[0]);
  assert.deepEqual(flow.slice(-3), ['focusGet','focusDelete','focusGet']);
  const document = await invoke(f.handler, 'documento', { tipo: 'danfe' });
  assert.equal(document.statusCode, 200);
  assert.ok(document.buffer.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.equal(document.headers['Content-Type'], 'application/pdf');
  assert.match(document.headers['Content-Disposition'], /attachment/);
  assert.match(document.headers['Cache-Control'], /no-store/);
  assert.equal('Access-Control-Allow-Origin' in document.headers, false);
});

test('Supabase lê com JWT admin/RLS, mutações usam service-role e nunca seguem redirects', async () => {
  const calls = [];
  const store = createFiscalStore({ config: { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon', serviceKey: 'service' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => url.endsWith('/user') ? { id: ID } : url.endsWith('jk_nf_e_admin') ? true : url.includes('jk_nf_config?') ? [fiscalConfig()] : url.includes('jk_notas_fiscais?') ? [note()] : note() }; } });
  await store.authenticate('user-token'); await store.isAdmin('user-token'); await store.getNote(ID, 'user-token'); await store.getConfig('user-token');
  await store.reserve({ p_id: ID }); await store.register({ p_id: ID });
  for (const call of calls.slice(0,4)) assert.equal(call.options.headers.Authorization, 'Bearer user-token');
  for (const call of calls.slice(4)) assert.equal(call.options.headers.Authorization, 'Bearer service');
  for (const call of calls) assert.equal(call.options.redirect, 'error');
  assert.match(calls[3].url, /id=eq.true/);
});

test('erros internos não expõem token, payload ou resposta bruta', async () => {
  const f = fixture(); f.provider.get = async () => { throw new Error('server-secret raw provider payload'); };
  const response = await invoke(f.handler);
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.stringify(response.json).includes('server-secret'), false);
  assert.equal((await invoke(f.handler, 'prever', {}, undefined, 'GET')).statusCode, 405);
});
