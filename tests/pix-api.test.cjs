'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPixHandler, createStore } = require('../lib/pix-handler.cjs');
const { PixError } = require('../lib/bb-pix.cjs');
const ID = '11111111-1111-1111-1111-111111111111';
const TXID = 'jk' + '1'.repeat(32);
const NOW = Date.parse('2026-10-26T15:00:00Z');
function row(extra = {}) { return { pedido_id: ID, status: 'pronta', total: '123.45', frete: '10.00', desconto: '2.00', txid: TXID, ...extra }; }
function charge(extra = {}) { return { txid: TXID, chave: 'test-key', status: 'ATIVA',
  valor: { original: '123.45', modalidadeAlteracao: 0 },
  calendario: { criacao: '2026-10-26T15:00:00Z', expiracao: 3600 },
  pixCopiaECola: '000201' + 'x'.repeat(50), ...extra }; }
function fixture(initial = row(), bankOverride = {}) {
  let saved = initial && { ...initial };
  let bankCharge = null;
  const calls = [];
  const store = {
    authenticate: async token => { calls.push(['auth', token]); if (token !== 'valid') throw new PixError('PIX_NAO_AUTORIZADO', 401); return { id: ID }; },
    get: async (id, token) => { calls.push(['get', id, token]); return saved && { ...saved }; },
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'jk_pix_reservar' && saved.status === 'pronta') saved.status = 'solicitando';
      if (name === 'jk_pix_salvar_cobranca' && saved.status !== 'paga') Object.assign(saved, { status: 'ativa', pix_copia_cola: args.p_codigo, expira_em: args.p_expira_em });
      if (name === 'jk_pix_confirmar') Object.assign(saved, { status: 'paga', pago_em: args.p_pago_em });
      if (name === 'jk_pix_expirar' && saved.status !== 'paga') saved.status = 'expirada';
      return { ...saved };
    }
  };
  const bank = {
    getCharge: async txid => { calls.push(['bankGet', txid]); return bankCharge; },
    createCharge: async (txid, total) => { calls.push(['bankPut', txid, total]); bankCharge = charge(); return bankCharge; },
    ...bankOverride
  };
  const handler = createPixHandler({ config: { chave: 'test-key' }, store, bank, now: () => NOW,
    qr: async code => 'data:image/png;base64,TEST' });
  return { handler, calls, store, bank, setCharge: value => { bankCharge = value; }, getRow: () => saved };
}
async function invoke(handler, body = { pedido_id: ID, acao: 'cobrar' }, headers = { authorization: 'Bearer valid' }, method = 'POST') {
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.json = JSON.parse(value); } };
  await handler({ method, headers, body }, response);
  return response;
}

test('sem ativação/configuração responde 503 sem autenticar nem contatar banco', async () => {
  const handler = createPixHandler({ env: {} });
  const response = await invoke(handler);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json.code, 'PIX_INDISPONIVEL');
  assert.match(response.headers['Cache-Control'], /no-store/);
  assert.equal('Access-Control-Allow-Origin' in response.headers, false);
});

test('autentica antes de acessar pedido; outro dono/não preparado não revela dados', async () => {
  const f = fixture(null);
  let response = await invoke(f.handler, undefined, { authorization: 'Bearer invalid' });
  assert.equal(response.statusCode, 401);
  assert.equal(f.calls.some(c => c[0] === 'get'), false);
  response = await invoke(f.handler);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'PIX_AGUARDANDO_LOJA');
  assert.equal(f.calls.some(c => c[0].startsWith('bank')), false);
});

test('rejeita valores do cliente e origem externa', async () => {
  const f = fixture();
  let response = await invoke(f.handler, { pedido_id: ID, acao: 'cobrar', total: 1 });
  assert.equal(response.statusCode, 400);
  response = await invoke(f.handler, undefined, { authorization: 'Bearer valid', origin: 'https://evil.test', host: 'loja.test' });
  assert.equal(response.statusCode, 403);
  assert.equal(f.calls.some(c => c[0].startsWith('bank')), false);
});

test('cobra com total servidor e repetições reconciliam mesmo txid sem novo PUT', async () => {
  const f = fixture();
  const first = await invoke(f.handler);
  const second = await invoke(f.handler);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json.status, 'ativa');
  assert.equal(first.json.total, 123.45);
  assert.equal(first.json.qr_data_url, 'data:image/png;base64,TEST');
  assert.equal(second.json.status, 'ativa');
  assert.equal(f.calls.filter(c => c[0] === 'bankPut').length, 1);
  assert.deepEqual(f.calls.find(c => c[0] === 'bankPut'), ['bankPut', TXID, '123.45']);
  assert.deepEqual(f.calls.filter(c => c[0] === 'bankGet').map(c => c[1]), [TXID, TXID]);
});

test('QR padrão é um PNG gerado pelo servidor, sem URL de serviço externo', async () => {
  const f = fixture();
  const handler = createPixHandler({ config: { chave: 'test-key' }, store: f.store, bank: f.bank, now: () => NOW });
  const response = await invoke(handler);
  assert.equal(response.statusCode, 200);
  assert.match(response.json.qr_data_url, /^data:image\/png;base64,/);
  const png = Buffer.from(response.json.qr_data_url.split(',')[1], 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('timeout após PUT aceito recupera cobrança com GET do mesmo txid', async () => {
  const f = fixture();
  let didPut = false;
  f.bank.getCharge = async txid => { f.calls.push(['bankGet', txid]); return didPut ? charge() : null; };
  f.bank.createCharge = async txid => { f.calls.push(['bankPut', txid]); didPut = true; throw new PixError('PIX_BANCO_INDISPONIVEL'); };
  const response = await invoke(f.handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.status, 'ativa');
  assert.deepEqual(f.calls.filter(c => c[0].startsWith('bank')).map(c => c[0]), ['bankGet', 'bankPut', 'bankGet']);
});

test('solicitações concorrentes usam o mesmo identificador e valor reservado', async () => {
  const f = fixture();
  const responses = await Promise.all([invoke(f.handler), invoke(f.handler), invoke(f.handler)]);
  for (const response of responses) assert.equal(response.json.status, 'ativa');
  const puts = f.calls.filter(c => c[0] === 'bankPut');
  assert.ok(puts.length >= 1);
  assert.deepEqual([...new Set(puts.map(c => c[1]))], [TXID]);
  assert.deepEqual([...new Set(puts.map(c => c[2]))], ['123.45']);
});

test('reserva que encontra pagamento concorrente retorna paga sem acessar o banco', async () => {
  const f = fixture();
  f.store.rpc = async () => row({ status: 'paga', pago_em: '2026-10-26T15:00:00Z' });
  const response = await invoke(f.handler);
  assert.equal(response.json.status, 'paga');
  assert.equal(f.calls.some(c => c[0].startsWith('bank')), false);
});

test('timeout não resolvido mantém reserva, e retry não troca txid', async () => {
  const f = fixture();
  f.bank.createCharge = async txid => { f.calls.push(['bankPut', txid]); throw new PixError('PIX_BANCO_INDISPONIVEL'); };
  const response = await invoke(f.handler);
  assert.equal(response.statusCode, 502);
  assert.equal(f.getRow().status, 'solicitando');
  assert.equal(f.getRow().txid, TXID);
  f.setCharge(charge());
  const retried = await invoke(f.handler);
  assert.equal(retried.json.status, 'ativa');
  assert.equal(f.calls.filter(c => c[0] === 'bankPut').length, 1);
});

test('consulta não cria cobrança nem confirma status ATIVA', async () => {
  const f = fixture(row({ status: 'solicitando' }));
  let response = await invoke(f.handler, { pedido_id: ID, acao: 'consultar' });
  assert.equal(response.json.status, 'solicitando');
  f.setCharge(charge());
  response = await invoke(f.handler, { pedido_id: ID, acao: 'consultar' });
  assert.equal(response.json.status, 'ativa');
  assert.equal(f.calls.some(c => c[0] === 'bankPut' || c[0] === 'jk_pix_confirmar'), false);
});

test('pagamento confirmado exige recibo integral; duas consultas não duplicam confirmação', async () => {
  const f = fixture(row({ status: 'ativa' }));
  f.setCharge(charge({ status: 'CONCLUIDA', pix: [{ txid: TXID, valor: '123.45',
    endToEndId: 'E' + '1'.repeat(31), horario: '2026-10-26T15:00:00Z' }] }));
  const response = await invoke(f.handler, { pedido_id: ID, acao: 'consultar' });
  await invoke(f.handler, { pedido_id: ID, acao: 'consultar' });
  assert.equal(response.json.status, 'paga');
  assert.equal(response.json.pix_copia_cola, null);
  assert.equal(f.calls.filter(c => c[0] === 'jk_pix_confirmar').length, 1);
});

test('parcial ou devolvido não chama RPC confirmar e não expõe resposta bruta', async () => {
  for (const receipt of [{ valor: '1.00' }, { valor: '123.45', devolucoes: [{ status: 'DEVOLVIDO' }] }]) {
    const f = fixture(row({ status: 'ativa' }));
    f.setCharge(charge({ status: 'CONCLUIDA', pix: [{ txid: TXID, endToEndId: 'E' + '1'.repeat(31), horario: '2026-10-26T15:00:00Z', ...receipt }] }));
    const response = await invoke(f.handler, { pedido_id: ID, acao: 'consultar' });
    assert.equal(response.statusCode, 409);
    assert.equal(f.calls.some(c => c[0] === 'jk_pix_confirmar'), false);
    assert.equal(JSON.stringify(response.json).includes('DEVOLVIDO'), false);
  }
});

test('cobrança vencida oculta QR; recibo confirmado posteriormente pode reconciliar', async () => {
  const f = fixture(row({ status: 'ativa' }));
  f.setCharge(charge({ calendario: { criacao: '2026-10-26T13:00:00Z', expiracao: 3600 } }));
  let response = await invoke(f.handler, { pedido_id: ID, acao: 'consultar' });
  assert.equal(response.json.status, 'expirada');
  assert.equal(response.json.qr_data_url, null);
  f.setCharge(charge({ status: 'CONCLUIDA', pix: [{ txid: TXID, valor: '123.45', endToEndId: 'E' + '1'.repeat(31), horario: '2026-10-26T13:59:59Z' }] }));
  response = await invoke(f.handler, { pedido_id: ID, acao: 'consultar' });
  assert.equal(response.json.status, 'paga');
});

test('Supabase autentica usuário e usa autorização dele no RPC obter; service key só nas mutações', async () => {
  const calls = [];
  const config = { supabaseUrl: 'https://example.supabase.co', anonKey: 'anon', serviceKey: 'service' };
  const store = createStore({ config, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/user') ? { id: ID } : row() };
  } });
  await store.authenticate('user-token');
  await store.get(ID, 'user-token');
  await store.rpc('jk_pix_reservar', { p_pedido_id: ID });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer user-token');
  assert.equal(calls[1].options.headers.apikey, 'anon');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer user-token');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer service');
  assert.equal(calls[2].options.redirect, 'error');
});

test('GET e corpo malformado são recusados sem expor detalhes internos', async () => {
  const f = fixture();
  assert.equal((await invoke(f.handler, undefined, undefined, 'GET')).statusCode, 405);
  assert.equal((await invoke(f.handler, '{')).statusCode, 400);
  f.bank.getCharge = async () => { throw new Error('test-secret access-token raw-bank-body'); };
  const response = await invoke(f.handler);
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.stringify(response.json).includes('test-secret'), false);
});
