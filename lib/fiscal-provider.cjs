'use strict';

const https = require('node:https');

const BASES = Object.freeze({
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br'
});

class FiscalError extends Error {
  constructor(code, status = 502, message, field) {
    super(message || code);
    this.name = 'FiscalError';
    this.code = code;
    this.status = status;
    if (field) this.field = field;
  }
}

class FiscalProviderError extends FiscalError {
  constructor(httpStatus) {
    super([400, 422].includes(httpStatus) ? 'FISCAL_REJEITADA' : 'FISCAL_EMISSOR_INDISPONIVEL',
      [400, 422].includes(httpStatus) ? 422 : 502);
    this.httpStatus = httpStatus;
  }
}

function readFiscalConfig(env = process.env, { allowDisabled = false } = {}) {
  const environment = env.FISCAL_ENVIRONMENT || (allowDisabled ? 'homologacao' : null);
  if (!Object.hasOwn(BASES, environment)) throw new FiscalError('FISCAL_INDISPONIVEL', 503);
  const hasToken = typeof env.FOCUS_NFE_TOKEN === 'string' && !!env.FOCUS_NFE_TOKEN.trim() && !/[\r\n]/.test(env.FOCUS_NFE_TOKEN);
  const enabled = env.FISCAL_ENABLED === 'true' && !!env.FISCAL_ENVIRONMENT && hasToken &&
    !(environment === 'producao' && env.VERCEL_ENV && env.VERCEL_ENV !== 'production');
  if (!allowDisabled && !enabled) throw new FiscalError('FISCAL_INDISPONIVEL', 503);
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (typeof env[key] !== 'string' || !env[key].trim() || /[\r\n]/.test(env[key])) {
      throw new FiscalError('FISCAL_INDISPONIVEL', 503);
    }
  }
  let supabase;
  try { supabase = new URL(env.SUPABASE_URL); }
  catch { throw new FiscalError('FISCAL_INDISPONIVEL', 503); }
  if (supabase.protocol !== 'https:' || supabase.username || supabase.password || supabase.search ||
      supabase.hash || !['', '/'].includes(supabase.pathname)) throw new FiscalError('FISCAL_INDISPONIVEL', 503);
  let siteOrigin = null;
  if (env.FISCAL_SITE_ORIGIN) {
    try {
      const origin = new URL(env.FISCAL_SITE_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== env.FISCAL_SITE_ORIGIN) throw new Error();
      siteOrigin = origin.origin;
    } catch { throw new FiscalError('FISCAL_INDISPONIVEL', 503); }
  }
  return Object.freeze({ environment, enabled, environmentConfigured: !!env.FISCAL_ENVIRONMENT,
    baseUrl: BASES[environment], token: hasToken ? env.FOCUS_NFE_TOKEN : null,
    supabaseUrl: supabase.origin, anonKey: env.SUPABASE_ANON_KEY,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, siteOrigin });
}

function trustedDocumentUrl(path, baseUrl, type) {
  if (typeof path !== 'string' || path.length > 2048 || /[\r\n\x00]/.test(path)) throw new FiscalError('FISCAL_DOCUMENTO_INVALIDO', 502);
  let url;
  try { url = new URL(path, baseUrl); } catch { throw new FiscalError('FISCAL_DOCUMENTO_INVALIDO', 502); }
  const suffix = type === 'xml' ? '.xml' : '.pdf';
  if (url.origin !== baseUrl || url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !url.pathname.toLowerCase().endsWith(suffix) ||
      !/^\/(?:arquivos[^/]*|notas_fiscais)(?:\/|$)/.test(url.pathname)) {
    throw new FiscalError('FISCAL_DOCUMENTO_INVALIDO', 502);
  }
  return url.href;
}

function httpsResponse(url, { method = 'GET', headers = {}, body, binary = false, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let deadline;
    const request = https.request(url, {
      method, minVersion: 'TLSv1.2', rejectUnauthorized: true,
      headers: body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) }
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > (binary ? 16 * 1024 * 1024 : 2 * 1024 * 1024)) {
          response.destroy(); request.destroy();
          clearTimeout(deadline); reject(new FiscalError('FISCAL_RESPOSTA_INVALIDA'));
        } else chunks.push(chunk);
      });
      response.on('error', () => { clearTimeout(deadline); reject(new FiscalError('FISCAL_EMISSOR_INDISPONIVEL')); });
      response.on('end', () => {
        clearTimeout(deadline);
        const buffer = Buffer.concat(chunks);
        let json = null;
        if (!binary && buffer.length) {
          try { json = JSON.parse(buffer.toString('utf8')); }
          catch { if (response.statusCode < 400) return reject(new FiscalError('FISCAL_RESPOSTA_INVALIDA')); }
        }
        resolve({ status: response.statusCode, json, buffer, contentType: response.headers['content-type'] || '' });
      });
    });
    deadline = setTimeout(() => request.destroy(new Error('timeout')), timeoutMs);
    deadline.unref();
    request.on('error', () => { clearTimeout(deadline); reject(new FiscalError('FISCAL_EMISSOR_INDISPONIVEL')); });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function createFocusProvider({ config, request = httpsResponse }) {
  if (!Object.hasOwn(BASES, config.environment) || config.baseUrl !== BASES[config.environment]) throw new FiscalError('FISCAL_INDISPONIVEL', 503);
  const authorization = `Basic ${Buffer.from(`${config.token}:`).toString('base64')}`;
  function reference(value) {
    if (typeof value !== 'string' || !/^jk[0-9a-f]{32}$/.test(value)) throw new FiscalError('FISCAL_CONFLITO', 409);
    return value;
  }
  async function json(method, url, body, nullable = false) {
    const response = await request(url, {
      method, headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (nullable && response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) throw new FiscalProviderError(response.status);
    if (!response.json || typeof response.json !== 'object' || Array.isArray(response.json)) throw new FiscalError('FISCAL_RESPOSTA_INVALIDA');
    return { data: response.json, httpStatus: response.status };
  }
  return {
    get: ref => json('GET', `${config.baseUrl}/v2/nfe/${reference(ref)}?completa=1`, undefined, true),
    emit: (ref, payload) => json('POST', `${config.baseUrl}/v2/nfe?ref=${reference(ref)}`, payload),
    cancel(ref, justification) {
      if (typeof justification !== 'string' || justification.trim().length < 15 || justification.trim().length > 255) {
        throw new FiscalError('FISCAL_VALIDACAO', 422, 'justificativa: informe entre 15 e 255 caracteres.', 'justificativa');
      }
      return json('DELETE', `${config.baseUrl}/v2/nfe/${reference(ref)}`, { justificativa: justification.trim() });
    },
    async document(path, type) {
      if (!['xml', 'danfe'].includes(type)) throw new FiscalError('FISCAL_DOCUMENTO_INVALIDO', 400);
      const url = trustedDocumentUrl(path, config.baseUrl, type);
      const response = await request(url, { binary: true, headers: { Authorization: authorization, Accept: type === 'xml' ? 'application/xml' : 'application/pdf' } });
      if (response.status !== 200 || !Buffer.isBuffer(response.buffer)) throw new FiscalError('FISCAL_DOCUMENTO_INVALIDO');
      const first = response.buffer.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
      if ((type === 'danfe' && !first.startsWith('%PDF-')) ||
          (type === 'xml' && (!first.startsWith('<') || !/<(?:\w+:)?(?:nfeProc|NFe)\b/.test(first)))) {
        throw new FiscalError('FISCAL_DOCUMENTO_INVALIDO');
      }
      return { buffer: response.buffer, contentType: type === 'xml' ? 'application/xml' : 'application/pdf' };
    }
  };
}

function normalizedKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.replace(/^NFe/, '');
  return /^\d{44}$/.test(key) ? key : null;
}

function normalizeFocusResult(response, expected) {
  const raw = response?.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      raw.ref !== expected.reference || raw.cnpj_emitente !== expected.cnpj) throw new FiscalError('FISCAL_RESPOSTA_DIVERGENTE', 409);
  for (const object of [raw.requisicao_nota_fiscal, raw.protocolo_nota_fiscal]) {
    if (object !== undefined && object !== null && (typeof object !== 'object' || Array.isArray(object))) throw new FiscalError('FISCAL_RESPOSTA_INVALIDA');
  }
  const environment = expected.environment === 'producao' ? '1' : '2';
  for (const supplied of [raw.ambiente, raw.requisicao_nota_fiscal?.ambiente, raw.protocolo_nota_fiscal?.ambiente]) {
    if (supplied !== undefined && supplied !== null && String(supplied) !== environment) throw new FiscalError('FISCAL_RESPOSTA_DIVERGENTE', 409);
  }
  if (raw.requisicao_nota_fiscal?.cnpj_emitente !== undefined && raw.requisicao_nota_fiscal.cnpj_emitente !== expected.cnpj) {
    throw new FiscalError('FISCAL_RESPOSTA_DIVERGENTE', 409);
  }
  const statuses = { processando_autorizacao: 'processando', autorizado: 'autorizada', erro_autorizacao: 'rejeitada', cancelado: 'cancelada' };
  const status = Object.hasOwn(statuses, raw.status) ? statuses[raw.status] : null;
  if (!status || (response.httpStatus === 202 && status !== 'processando')) throw new FiscalError('FISCAL_RESPOSTA_INVALIDA');
  const result = { documentos: {} };
  if (status === 'autorizada' || status === 'cancelada') {
    const key = normalizedKey(raw.chave_nfe);
    const number = String(raw.numero ?? '');
    const series = String(raw.serie ?? '');
    if (!key || !/^[1-9]\d{0,8}$/.test(number) || !/^\d{1,3}$/.test(series) ||
        (status === 'autorizada' && raw.status_sefaz !== undefined && !['100', '150'].includes(String(raw.status_sefaz)))) {
      throw new FiscalError('FISCAL_RESPOSTA_INVALIDA');
    }
    if (expected.key && key !== expected.key) throw new FiscalError('FISCAL_RESPOSTA_DIVERGENTE', 409);
    const protocol = raw.protocolo_nota_fiscal;
    if (protocol && typeof protocol === 'object') {
      if ((protocol.chave_nfe !== undefined && normalizedKey(protocol.chave_nfe) !== key) ||
          (status === 'autorizada' && protocol.status !== undefined && !['100', '150'].includes(String(protocol.status)))) {
        throw new FiscalError('FISCAL_RESPOSTA_DIVERGENTE', 409);
      }
      if (protocol.numero_protocolo !== undefined) {
        if (!/^\d{15}$/.test(String(protocol.numero_protocolo))) throw new FiscalError('FISCAL_RESPOSTA_INVALIDA');
        result.protocolo = String(protocol.numero_protocolo);
      }
    }
    Object.assign(result, { chave: key, numero: number, serie: series });
    for (const [type, path] of [['xml', raw.caminho_xml_nota_fiscal], ['danfe', raw.caminho_danfe]]) {
      if (path !== undefined && path !== null && path !== '') result.documentos[type] = trustedDocumentUrl(path, BASES[expected.environment], type);
    }
  }
  if (status === 'rejeitada') {
    const code = /^\d{2,4}$/.test(String(raw.status_sefaz ?? '')) ? ` (SEFAZ ${raw.status_sefaz})` : '';
    result.erro = `Emissão rejeitada${code}. Revise os dados fiscais com a contabilidade antes de reenviar.`;
  }
  return { status, result };
}

module.exports = { FiscalError, FiscalProviderError, BASES, readFiscalConfig, trustedDocumentUrl,
  httpsResponse, createFocusProvider, normalizeFocusResult };
