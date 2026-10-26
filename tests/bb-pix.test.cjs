'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readConfig, cents, amount, createBBPixClient, validateCharge } = require('../lib/bb-pix.cjs');

const NOW = Date.parse('2026-10-26T15:00:00.000Z');
const TXID = 'jk11111111111111111111111111111111';
const E2E = 'E' + '1'.repeat(31);
function environment(extra = {}) {
  return { BB_PIX_ENABLED: 'true', BB_PIX_ENVIRONMENT: 'production',
    BB_PIX_API_BASE_URL: 'https://pix.example.bb.com.br/pix/v2',
    BB_PIX_OAUTH_URL: 'https://oauth.example.bb.com.br/oauth/token',
    BB_PIX_APP_KEY: 'test-app', BB_PIX_CLIENT_ID: 'test-id', BB_PIX_CLIENT_SECRET: 'test-secret',
    BB_PIX_CHAVE: 'test-key', BB_PIX_CERT_PEM: '-----BEGIN CERTIFICATE-----\\nTEST\\n-----END CERTIFICATE-----',
    BB_PIX_KEY_PEM: '-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----',
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', ...extra };
}
function charge(extra = {}) {
  return { txid: TXID, chave: 'test-key', status: 'ATIVA', valor: { original: '123.45', modalidadeAlteracao: 0 },
    calendario: { criacao: '2026-10-26T15:00:00.000Z', expiracao: 3600 },
    pixCopiaECola: '000201' + 'x'.repeat(50), ...extra };
}
const expected = { txid: TXID, total: '123.45', chave: 'test-key' };

test('configuração só ativa por opt-in exato e produção explícita', () => {
  for (const extra of [{ BB_PIX_ENABLED: 'false' }, { BB_PIX_ENABLED: 'TRUE' },
    { BB_PIX_ENVIRONMENT: 'sandbox' }, { BB_PIX_ENVIRONMENT: '' }, { BB_PIX_CHAVE: '' },
    { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' },
    { BB_PIX_CERT_PEM: '' }, { SUPABASE_SERVICE_ROLE_KEY: '' }]) {
    assert.throws(() => readConfig(environment(extra)), { code: 'PIX_INDISPONIVEL', status: 503 });
  }
  assert.equal(readConfig(environment()).cert.includes('\nTEST\n'), true);
});

test('hosts são HTTPS BB sem redirecionamento nem parâmetros ou userinfo', () => {
  for (const value of ['http://pix.bb.com.br', 'https://pix.bb.com.br.evil.test', 'https://evil.test',
    'https://user:secret@pix.bb.com.br', 'https://pix.bb.com.br:444', 'https://pix.bb.com.br/a?x=1',
    'https://127.0.0.1', 'https://bb.com.br']) {
    assert.throws(() => readConfig(environment({ BB_PIX_API_BASE_URL: value })), { code: 'PIX_INDISPONIVEL' });
  }
});

test('valores usam centavos, sem arredondar valores fracionários indevidos', () => {
  assert.equal(cents('123.45'), 12345);
  assert.equal(cents(0.29), 29);
  assert.equal(amount('123'), '123.00');
  for (const value of ['0', '-1.00', 'NaN', '1e2', '1.234', 1.234, Infinity]) assert.throws(() => cents(value));
});

test('OAuth usa escopo mínimo e mTLS; appkey aparece somente nas chamadas Pix', async () => {
  const config = readConfig(environment());
  const calls = [];
  const bank = createBBPixClient({ config, now: () => NOW, request: async (url, options) => {
    calls.push({ url, options });
    if (url === config.oauthUrl) return { status: 200, json: { access_token: 'access', token_type: 'Bearer', expires_in: 3600 } };
    return { status: options.method === 'GET' ? 404 : 201, json: options.method === 'GET' ? null : charge() };
  } });
  assert.equal(await bank.getCharge(TXID), null);
  await bank.createCharge(TXID, '123.45');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.includes('gw-dev-app-key'), false);
  assert.equal(new URLSearchParams(calls[0].options.body).get('scope'), 'cob.read cob.write pix.read');
  for (const call of calls) { assert.equal(call.options.cert, config.cert); assert.equal(call.options.key, config.key); }
  assert.equal(new URL(calls[1].url).searchParams.get('gw-dev-app-key'), 'test-app');
  const sent = JSON.parse(calls[2].options.body);
  assert.deepEqual(sent.valor, { original: '123.45', modalidadeAlteracao: 0 });
  assert.equal(sent.chave, 'test-key');
});

test('ATIVA é somente cobrança, nunca confirmação de pagamento', () => {
  const result = validateCharge(charge(), expected, NOW);
  assert.equal(result.paid, false);
  assert.equal(result.expired, false);
  assert.equal(result.expiresAt, '2026-10-26T16:00:00.000Z');
  assert.equal(validateCharge(charge(), expected, NOW + 3600001).expired, true);
});

test('confirma somente recibo integral, correspondente e sem devolução', () => {
  const receipt = { txid: TXID, endToEndId: E2E, valor: '123.45', horario: '2026-10-26T15:00:00.000Z' };
  const paid = charge({ status: 'CONCLUIDA', pix: [receipt] });
  assert.deepEqual(validateCharge(paid, expected, NOW), { paid: true, endToEndId: E2E, paidAt: '2026-10-26T15:00:00.000Z' });
  for (const extra of [{ pix: [] }, { pix: [receipt, receipt] },
    { pix: [{ ...receipt, valor: '1.00' }] }, { pix: [{ ...receipt, txid: 'outro' }] },
    { pix: [{ ...receipt, endToEndId: 'fake' }] }, { pix: [{ ...receipt, horario: 'inválido' }] },
    { pix: [{ ...receipt, horario: '2027-01-01T00:00:00Z' }] },
    { pix: [{ ...receipt, devolucoes: [{ valor: '1.00' }] }] },
    { valor: { original: '120.00' } }, { chave: 'outra-chave' }, { txid: 'outro' },
    { valor: { original: 123.45 } }, { valor: { original: '123.45', modalidadeAlteracao: 1 } }]) {
    assert.throws(() => validateCharge({ ...paid, ...extra }, expected, NOW), { code: 'PIX_DIVERGENTE' });
  }
});

test('respostas ambíguas, removidas ou QR sem estrutura são bloqueadas', () => {
  assert.throws(() => validateCharge(charge({ status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' }), expected, NOW), { code: 'PIX_COBRANCA_ENCERRADA' });
  assert.throws(() => validateCharge(charge({ pixCopiaECola: 'https://evil.test' }), expected, NOW), { code: 'PIX_RESPOSTA_INVALIDA' });
  assert.throws(() => validateCharge(charge({ pix: [{ valor: '123.45' }] }), expected, NOW), { code: 'PIX_DIVERGENTE' });
});

module.exports = { environment, charge, TXID, E2E, NOW };
