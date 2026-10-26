'use strict';

const { FiscalError, readFiscalConfig, createFocusProvider, normalizeFocusResult } = require('./fiscal-provider.cjs');
const { buildFiscalPayload } = require('./fiscal-payload.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGES = {
  FISCAL_INDISPONIVEL: 'A emissão fiscal ainda não está ativada neste ambiente. Rascunhos e revisão continuam disponíveis.',
  FISCAL_NAO_AUTORIZADO: 'Acesso restrito aos administradores da loja. Entre novamente na sua conta.',
  FISCAL_REQUISICAO_INVALIDA: 'Solicitação fiscal inválida.',
  FISCAL_NAO_ENCONTRADA: 'Nota fiscal não encontrada.',
  FISCAL_CONFIGURACAO: 'Cadastre e revise a configuração fiscal antes de emitir.',
  FISCAL_CONFIG_ALTERADA: 'A configuração fiscal mudou. Revise e salve o rascunho novamente.',
  FISCAL_AMBIENTE_ALTERADO: 'O ambiente fiscal mudou desde a revisão. Revise a nota novamente antes de emitir.',
  FISCAL_CONFLITO: 'Esta nota mudou durante a operação. Atualize a lista antes de continuar.',
  FISCAL_ESTADO_INVALIDO: 'Esta operação não está disponível no estado atual da nota.',
  FISCAL_ENVIO_INDEFINIDO: 'O envio ainda não pôde ser confirmado. Consulte novamente a mesma nota; não crie outra emissão.',
  FISCAL_RESPOSTA_DIVERGENTE: 'A resposta fiscal não corresponde à nota reservada. A emissão permanece bloqueada para conferência.',
  FISCAL_RESPOSTA_INVALIDA: 'Não foi possível validar a resposta do emissor. Consulte a mesma nota antes de continuar.',
  FISCAL_EMISSOR_INDISPONIVEL: 'O emissor não respondeu com segurança. Consulte novamente a mesma nota.',
  FISCAL_REJEITADA: 'O emissor recusou a solicitação. Consulte a mesma referência antes de corrigir ou reenviar.',
  FISCAL_CANCELAMENTO_RECUSADO: 'O cancelamento não foi confirmado. Consulte a situação da nota antes de tentar novamente.',
  FISCAL_DOCUMENTO_INVALIDO: 'Não foi possível obter um documento fiscal válido.',
  FISCAL_ERRO_INTERNO: 'Não foi possível concluir a operação fiscal. Tente consultar novamente mais tarde.'
};

function createFiscalStore({ config, fetchImpl = fetch }) {
  async function call(path, token, apiKey, body, { auth = false, conflict = false } = {}) {
    let response;
    try {
      response = await fetchImpl(`${config.supabaseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { apikey: apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000), redirect: 'error'
      });
    } catch { throw new FiscalError('FISCAL_ERRO_INTERNO', 503); }
    if (!response.ok) {
      if (auth || response.status === 401 || response.status === 403) throw new FiscalError('FISCAL_NAO_AUTORIZADO', 403);
      if (conflict && [400, 409].includes(response.status)) throw new FiscalError('FISCAL_CONFLITO', 409);
      throw new FiscalError('FISCAL_ERRO_INTERNO', 503);
    }
    try { return await response.json(); } catch { throw new FiscalError('FISCAL_ERRO_INTERNO', 503); }
  }
  async function one(path, token) {
    const result = await call(path, token, config.anonKey);
    if (!Array.isArray(result) || result.length > 1) throw new FiscalError('FISCAL_ERRO_INTERNO', 503);
    return result[0] || null;
  }
  return {
    authenticate: token => call('/auth/v1/user', token, config.anonKey, undefined, { auth: true }),
    isAdmin: token => call('/rest/v1/rpc/jk_nf_e_admin', token, config.anonKey, {}, { auth: true }),
    getNote: (id, token) => one(`/rest/v1/jk_notas_fiscais?id=eq.${id}&select=*`, token),
    getConfig: token => one('/rest/v1/jk_nf_config?id=eq.true&select=*', token),
    reserve: args => call('/rest/v1/rpc/jk_nf_reservar', config.serviceKey, config.serviceKey, args, { conflict: true }),
    register: args => call('/rest/v1/rpc/jk_nf_registrar', config.serviceKey, config.serviceKey, args, { conflict: true })
  };
}

async function readBody(req) {
  let body = req.body;
  if (body === undefined) {
    body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 4096) throw new FiscalError('FISCAL_REQUISICAO_INVALIDA', 400);
    }
  }
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > 4096) throw new FiscalError('FISCAL_REQUISICAO_INVALIDA', 400);
    try { body = JSON.parse(body); } catch { throw new FiscalError('FISCAL_REQUISICAO_INVALIDA', 400); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FiscalError('FISCAL_REQUISICAO_INVALIDA', 400);
  const allowed = { prever: ['acao', 'id'], emitir: ['acao', 'id', 'versao', 'ambiente'],
    consultar: ['acao', 'id'], cancelar: ['acao', 'id', 'justificativa'], documento: ['acao', 'id', 'tipo'] };
  if (!allowed[body.acao] || !UUID.test(body.id || '') || Object.keys(body).some(key => !allowed[body.acao].includes(key))) throw new FiscalError('FISCAL_REQUISICAO_INVALIDA', 400);
  if (body.acao === 'emitir' && (!Number.isInteger(body.versao) || body.versao < 1 || !['homologacao', 'producao'].includes(body.ambiente))) throw new FiscalError('FISCAL_REQUISICAO_INVALIDA', 400);
  if (body.acao === 'cancelar' && (typeof body.justificativa !== 'string' || body.justificativa.trim().length < 15 || body.justificativa.trim().length > 255)) throw new FiscalError('FISCAL_VALIDACAO', 422, 'justificativa: informe entre 15 e 255 caracteres.', 'justificativa');
  if (body.acao === 'documento' && !['xml', 'danfe'].includes(body.tipo)) throw new FiscalError('FISCAL_REQUISICAO_INVALIDA', 400);
  body.id = body.id.toLowerCase();
  return body;
}

function metadata(row, config) {
  return { id: row.id, status: row.status, versao: row.versao, ambiente: row.ambiente || config.environment,
    habilitado: config.enabled, numero: row.numero || null, serie: row.serie ?? null,
    chave: row.chave || null, protocolo: row.protocolo || null, erro: row.erro || null,
    total: row.snapshot?.valor_total || null,
    documentos: { xml: !!row.documentos?.xml, danfe: !!row.documentos?.danfe } };
}

function expectedFrom(row, config, payload = row.snapshot) {
  if (row.ambiente && row.ambiente !== config.environment) throw new FiscalError('FISCAL_AMBIENTE_ALTERADO', 409);
  if (!/^jk[0-9a-f]{32}$/.test(row.referencia || '') || !payload || typeof payload.cnpj_emitente !== 'string') throw new FiscalError('FISCAL_CONFLITO', 409);
  return { reference: row.referencia, cnpj: payload.cnpj_emitente, environment: config.environment, key: row.chave || undefined };
}

function sameAttempt(response, snapshot) {
  const request = response?.data?.requisicao_nota_fiscal;
  if (!request || typeof request !== 'object' || !snapshot?.data_emissao) return false;
  const sentAt = Date.parse(snapshot.data_emissao);
  return Number.isFinite(sentAt) && Date.parse(request.data_emissao) === sentAt &&
    request.cnpj_emitente === snapshot.cnpj_emitente;
}

function createFiscalHandler(options = {}) {
  let runtime;
  const now = options.now || (() => new Date());
  function getRuntime() {
    if (!runtime) {
      const config = options.config || readFiscalConfig(options.env || process.env, { allowDisabled: true });
      runtime = { config, store: options.store || createFiscalStore({ config, fetchImpl: options.fetchImpl }), provider: options.provider || null };
    }
    return runtime;
  }
  async function prepare(row, store, token, config) {
    if (!['rascunho', 'rejeitada'].includes(row.status)) throw new FiscalError('FISCAL_ESTADO_INVALIDO', 409);
    const saved = await store.getConfig(token);
    if (!saved?.dados) throw new FiscalError('FISCAL_CONFIGURACAO', 409);
    if (!Number.isInteger(row.dados?.config_versao) || row.dados.config_versao !== saved.versao) throw new FiscalError('FISCAL_CONFIG_ALTERADA', 409);
    if (row.ambiente && row.ambiente !== config.environment) throw new FiscalError('FISCAL_AMBIENTE_ALTERADO', 409);
    const result = buildFiscalPayload(row.dados, saved.dados, { now, environment: config.environment });
    if (row.snapshot?.cnpj_emitente && row.snapshot.cnpj_emitente !== result.payload.cnpj_emitente) throw new FiscalError('FISCAL_RESPOSTA_DIVERGENTE', 409);
    return result;
  }
  async function record(response, row, config, store, { direct = false } = {}) {
    const normalized = normalizeFocusResult(response, expectedFrom(row, config));
    // GET de uma referência reusada pode ainda descrever a tentativa rejeitada
    // anterior. Sem a requisição completa correspondente mantemos a trava.
    if (normalized.status === 'rejeitada' && !direct && !sameAttempt(response, row.snapshot)) throw new FiscalError('FISCAL_ENVIO_INDEFINIDO', 409);
    return store.register({ p_id: row.id, p_ambiente: row.ambiente,
      p_referencia: row.referencia, p_status: normalized.status,
      p_resultado: normalized.result, p_versao: row.versao });
  }
  return async function fiscalHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    function send(status, value) { res.statusCode = status; res.end(JSON.stringify(value)); }
    try {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { code: 'FISCAL_REQUISICAO_INVALIDA', message: MESSAGES.FISCAL_REQUISICAO_INVALIDA }); }
      const state = getRuntime();
      const { config, store } = state;
      const origin = req.headers?.origin;
      if (origin) {
        let allowed = false;
        try { const parsed = new URL(origin); allowed = parsed.origin === origin && parsed.protocol === 'https:' && (config.siteOrigin ? origin === config.siteOrigin : parsed.host === req.headers.host); } catch { /* deny */ }
        if (!allowed) throw new FiscalError('FISCAL_NAO_AUTORIZADO', 403);
      }
      const match = /^Bearer ([^\s]{1,20000})$/.exec(req.headers?.authorization || '');
      if (!match) throw new FiscalError('FISCAL_NAO_AUTORIZADO', 401);
      const token = match[1];
      const user = await store.authenticate(token);
      if (!UUID.test(user?.id || '') || user?.app_metadata?.loja_admin !== true || await store.isAdmin(token) !== true) throw new FiscalError('FISCAL_NAO_AUTORIZADO', 403);
      const body = await readBody(req);
      let row = await store.getNote(body.id, token);
      if (!row || row.id !== body.id) throw new FiscalError('FISCAL_NAO_ENCONTRADA', 404);
      if (body.acao === 'prever') {
        const preview = await prepare(row, store, token, config);
        return send(200, { id: row.id, versao: row.versao, total: preview.total, componentes: preview.componentes,
          ambiente: config.environment, ambiente_configurado: !!config.environmentConfigured, habilitado: !!config.enabled });
      }
      if (!config.enabled) throw new FiscalError('FISCAL_INDISPONIVEL', 503);
      if (row.ambiente && row.ambiente !== config.environment) throw new FiscalError('FISCAL_AMBIENTE_ALTERADO', 409);
      if (!state.provider) state.provider = createFocusProvider({ config });
      const provider = state.provider;
      if (body.acao === 'emitir') {
        if (body.ambiente !== config.environment) throw new FiscalError('FISCAL_AMBIENTE_ALTERADO', 409);
        if (row.status === 'rejeitada') throw new FiscalError('FISCAL_ESTADO_INVALIDO', 409);
        const fresh = row.status === 'rascunho';
        if (fresh && body.versao !== row.versao) throw new FiscalError('FISCAL_CONFLITO', 409);
        const prepared = fresh ? await prepare(row, store, token, config) : { payload: row.snapshot };
        const expected = expectedFrom(row, config, prepared.payload);
        // Falha do GET antes da reserva não consome uma tentativa nem autoriza POST.
        const previous = await provider.get(row.referencia);
        if (previous) normalizeFocusResult(previous, expected);
        if (fresh && ((previous && previous.data.status !== 'erro_autorizacao') ||
            (row.snapshot && (!previous || !sameAttempt(previous, row.snapshot))) ||
            (previous && !row.snapshot))) throw new FiscalError('FISCAL_ENVIO_INDEFINIDO', 409);
        row = await store.reserve({ p_id: row.id, p_versao: body.versao, p_payload: prepared.payload, p_ambiente: config.environment });
        if (!row || row.id !== body.id) throw new FiscalError('FISCAL_CONFLITO', 409);
        if (!row.pode_enviar) {
          if (!previous) throw new FiscalError('FISCAL_ENVIO_INDEFINIDO', 409);
          row = await record(previous, row, config, store);
          return send(200, metadata(row, config));
        }
        if (previous && previous.data.status !== 'erro_autorizacao') {
          row = await record(previous, row, config, store);
          return send(200, metadata(row, config));
        }
        let response;
        let direct = false;
        try { response = await provider.emit(row.referencia, row.snapshot); direct = true; }
        catch {
          // Timeout/HTTP incerto jamais libera o snapshot para edição/reemissão.
          response = await provider.get(row.referencia);
          if (!response) throw new FiscalError('FISCAL_ENVIO_INDEFINIDO', 409);
        }
        row = await record(response, row, config, store, { direct });
        return send(200, metadata(row, config));
      }
      if (!row.snapshot || !row.ambiente) throw new FiscalError('FISCAL_ESTADO_INVALIDO', 409);
      const response = await provider.get(row.referencia);
      if (!response) throw new FiscalError('FISCAL_ENVIO_INDEFINIDO', 409);
      row = await record(response, row, config, store);
      if (body.acao === 'consultar') return send(200, metadata(row, config));
      if (body.acao === 'cancelar') {
        if (row.status === 'cancelada') return send(200, metadata(row, config));
        if (row.status !== 'autorizada') throw new FiscalError('FISCAL_ESTADO_INVALIDO', 409);
        try {
          await provider.cancel(row.referencia, body.justificativa);
        } catch { /* A consulta seguinte resolve o estado após resposta incerta. */ }
        const refreshed = await provider.get(row.referencia);
        if (!refreshed) throw new FiscalError('FISCAL_CANCELAMENTO_RECUSADO', 409);
        row = await record(refreshed, row, config, store);
        if (row.status !== 'cancelada') throw new FiscalError('FISCAL_CANCELAMENTO_RECUSADO', 409);
        // A consulta autenticada com identidade válida prevalece após timeout.
        return send(200, metadata(row, config));
      }
      if (body.acao === 'documento') {
        if (!['autorizada', 'cancelada'].includes(row.status) || !row.documentos?.[body.tipo]) throw new FiscalError('FISCAL_DOCUMENTO_INVALIDO', 404);
        const document = await provider.document(row.documentos[body.tipo], body.tipo);
        if (!document || !Buffer.isBuffer(document.buffer)) throw new FiscalError('FISCAL_DOCUMENTO_INVALIDO');
        res.setHeader('Content-Type', document.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="nfe-${row.id}.${body.tipo === 'xml' ? 'xml' : 'pdf'}"`);
        res.setHeader('Content-Length', document.buffer.length);
        res.statusCode = 200; return res.end(document.buffer);
      }
      throw new FiscalError('FISCAL_REQUISICAO_INVALIDA', 400);
    } catch (error) {
      const recognized = error instanceof FiscalError;
      const code = recognized && (MESSAGES[error.code] || error.code === 'FISCAL_VALIDACAO') ? error.code : 'FISCAL_ERRO_INTERNO';
      const status = code === 'FISCAL_ERRO_INTERNO' ? 503 : error.status;
      const message = code === 'FISCAL_VALIDACAO' ? error.message : MESSAGES[code];
      return send(status, { code, message, ...(code === 'FISCAL_VALIDACAO' && error.field ? { campo: error.field } : {}) });
    }
  };
}

module.exports = { createFiscalHandler, createFiscalStore, metadata, sameAttempt };
