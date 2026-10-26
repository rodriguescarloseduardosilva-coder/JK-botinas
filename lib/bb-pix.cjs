'use strict';

const https = require('node:https');

class PixError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = 'PixError';
    this.code = code;
    this.status = status;
  }
}

function bankUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new PixError('PIX_INDISPONIVEL', 503); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.bb.com.br') ||
      url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) {
    throw new PixError('PIX_INDISPONIVEL', 503);
  }
  return url.href.replace(/\/$/, '');
}

function readConfig(env = process.env) {
  if (env.BB_PIX_ENABLED !== 'true' || env.BB_PIX_ENVIRONMENT !== 'production' ||
      (env.VERCEL_ENV && env.VERCEL_ENV !== 'production')) {
    throw new PixError('PIX_INDISPONIVEL', 503);
  }
  const required = ['BB_PIX_APP_KEY', 'BB_PIX_CLIENT_ID', 'BB_PIX_CLIENT_SECRET',
    'BB_PIX_CHAVE', 'BB_PIX_CERT_PEM', 'BB_PIX_KEY_PEM', 'SUPABASE_URL',
    'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  if (required.some(name => typeof env[name] !== 'string' || !env[name].trim())) {
    throw new PixError('PIX_INDISPONIVEL', 503);
  }
  const cert = env.BB_PIX_CERT_PEM.replace(/\\n/g, '\n');
  const key = env.BB_PIX_KEY_PEM.replace(/\\n/g, '\n');
  if (!cert.includes('-----BEGIN CERTIFICATE-----') ||
      !/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(key)) {
    throw new PixError('PIX_INDISPONIVEL', 503);
  }
  let supabaseUrl;
  try { supabaseUrl = new URL(env.SUPABASE_URL); } catch { throw new PixError('PIX_INDISPONIVEL', 503); }
  if (supabaseUrl.protocol !== 'https:' || supabaseUrl.username || supabaseUrl.password ||
      supabaseUrl.search || supabaseUrl.hash || !['', '/'].includes(supabaseUrl.pathname)) {
    throw new PixError('PIX_INDISPONIVEL', 503);
  }
  let siteOrigin = null;
  if (env.PIX_SITE_ORIGIN) {
    try {
      const origin = new URL(env.PIX_SITE_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== env.PIX_SITE_ORIGIN) throw new Error();
      siteOrigin = origin.origin;
    } catch { throw new PixError('PIX_INDISPONIVEL', 503); }
  }
  return Object.freeze({
    apiBaseUrl: bankUrl(env.BB_PIX_API_BASE_URL), oauthUrl: bankUrl(env.BB_PIX_OAUTH_URL),
    appKey: env.BB_PIX_APP_KEY, clientId: env.BB_PIX_CLIENT_ID, clientSecret: env.BB_PIX_CLIENT_SECRET,
    chave: env.BB_PIX_CHAVE, cert, key, supabaseUrl: supabaseUrl.origin,
    anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, siteOrigin,
    expirationSeconds: 3600
  });
}

function cents(value) {
  const string = typeof value === 'number' ? String(value) : value;
  if (typeof string !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(string)) {
    throw new PixError('PIX_DIVERGENTE', 409);
  }
  const [whole, fraction = ''] = string.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result <= 0) throw new PixError('PIX_DIVERGENTE', 409);
  return result;
}

function amount(value) { return (cents(value) / 100).toFixed(2); }

function bankCents(value) {
  if (typeof value !== 'string' || !/^\d{1,10}\.\d{2}$/.test(value)) throw new PixError('PIX_DIVERGENTE', 409);
  return cents(value);
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
}

function httpsJson(url, { method = 'GET', headers = {}, body, cert, key, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let deadline;
    const request = https.request(url, {
      method, headers: body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
      cert, key, minVersion: 'TLSv1.2', rejectUnauthorized: true
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.destroy();
          request.destroy(new PixError('PIX_RESPOSTA_INVALIDA'));
        } else chunks.push(chunk);
      });
      response.on('error', () => { clearTimeout(deadline); reject(new PixError('PIX_BANCO_INDISPONIVEL')); });
      response.on('end', () => {
        clearTimeout(deadline);
        let json = null;
        const raw = Buffer.concat(chunks).toString('utf8');
        try { if (raw) json = JSON.parse(raw); }
        catch { return reject(new PixError('PIX_RESPOSTA_INVALIDA')); }
        resolve({ status: response.statusCode, json });
      });
    });
    deadline = setTimeout(() => request.destroy(new PixError('PIX_BANCO_INDISPONIVEL')), timeoutMs);
    deadline.unref();
    request.on('error', () => { clearTimeout(deadline); reject(new PixError('PIX_BANCO_INDISPONIVEL')); });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function createBBPixClient({ config, request = httpsJson, now = () => Date.now() }) {
  let cachedToken = null;
  let tokenExpiresAt = 0;
  async function token() {
    if (cachedToken && tokenExpiresAt > now()) return cachedToken;
    const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'cob.read cob.write pix.read' }).toString();
    const result = await request(config.oauthUrl, {
      method: 'POST', cert: config.cert, key: config.key, body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}` }
    });
    if (result.status !== 200 || !result.json || typeof result.json.access_token !== 'string' ||
        !result.json.access_token || result.json.access_token.length > 20000 ||
        (result.json.token_type && result.json.token_type.toLowerCase() !== 'bearer')) {
      throw new PixError('PIX_BANCO_INDISPONIVEL');
    }
    cachedToken = result.json.access_token;
    tokenExpiresAt = now() + Math.max(0, Math.min(Number(result.json.expires_in) || 0, 3600) - 30) * 1000;
    return cachedToken;
  }
  async function call(method, txid, data) {
    if (!/^[A-Za-z0-9]{26,35}$/.test(txid)) throw new PixError('PIX_DIVERGENTE', 409);
    const url = new URL(`${config.apiBaseUrl}/cob/${txid}`);
    url.searchParams.set('gw-dev-app-key', config.appKey);
    const result = await request(url.href, {
      method, cert: config.cert, key: config.key,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: data ? JSON.stringify(data) : undefined
    });
    if (method === 'GET' && result.status === 404) return null;
    if (![200, 201].includes(result.status) || !result.json || typeof result.json !== 'object' || Array.isArray(result.json)) {
      if (result.status === 401) { cachedToken = null; tokenExpiresAt = 0; }
      throw new PixError('PIX_BANCO_INDISPONIVEL');
    }
    return result.json;
  }
  return {
    getCharge: txid => call('GET', txid),
    createCharge: (txid, total) => call('PUT', txid, {
      calendario: { expiracao: config.expirationSeconds }, chave: config.chave,
      valor: { original: amount(total), modalidadeAlteracao: 0 },
      solicitacaoPagador: 'Pagamento do pedido JK Botinas'
    })
  };
}

function validateCharge(charge, { txid, total, chave }, now = Date.now()) {
  if (!charge || charge.txid !== txid || !charge.valor || bankCents(charge.valor.original) !== cents(total) ||
      charge.chave !== chave || (charge.valor.modalidadeAlteracao !== undefined && charge.valor.modalidadeAlteracao !== 0)) {
    throw new PixError('PIX_DIVERGENTE', 409);
  }
  if (charge.status === 'CONCLUIDA') {
    // Não agregamos pagamentos parciais: cada pedido possui um recibo único auditável.
    if (!Array.isArray(charge.pix) || charge.pix.length !== 1) throw new PixError('PIX_DIVERGENTE', 409);
    const receipt = charge.pix[0];
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new PixError('PIX_DIVERGENTE', 409);
    const paidTimestamp = timestamp(receipt.horario);
    if (receipt.txid !== txid || bankCents(receipt.valor) !== cents(total) ||
        !/^[A-Za-z0-9]{32}$/.test(receipt.endToEndId || '') ||
        !Number.isFinite(paidTimestamp) || paidTimestamp > now + 300000 ||
        (receipt.devolucoes !== undefined && (!Array.isArray(receipt.devolucoes) || receipt.devolucoes.length > 0))) {
      throw new PixError('PIX_DIVERGENTE', 409);
    }
    return { paid: true, endToEndId: receipt.endToEndId, paidAt: new Date(paidTimestamp).toISOString() };
  }
  if (charge.status !== 'ATIVA') throw new PixError('PIX_COBRANCA_ENCERRADA', 409);
  if (charge.pix !== undefined && (!Array.isArray(charge.pix) || charge.pix.length > 0)) {
    throw new PixError('PIX_DIVERGENTE', 409);
  }
  const creation = timestamp(charge.calendario?.criacao);
  const expiration = charge.calendario?.expiracao;
  const code = charge.pixCopiaECola;
  if (!Number.isFinite(creation) || creation > now + 300000 || !Number.isInteger(expiration) ||
      expiration < 1 || expiration > 86400 || typeof code !== 'string' ||
      !code.startsWith('000201') || code.length < 30 || code.length > 2048 || /[\x00-\x1f\x7f]/.test(code)) {
    throw new PixError('PIX_RESPOSTA_INVALIDA');
  }
  const expiresAt = new Date(creation + expiration * 1000).toISOString();
  return { paid: false, code, expiresAt, expired: Date.parse(expiresAt) <= now };
}

module.exports = { PixError, readConfig, cents, amount, httpsJson, createBBPixClient, validateCharge };
