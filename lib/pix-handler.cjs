'use strict';

const { PixError, readConfig, createBBPixClient, validateCharge, amount } = require('./bb-pix.cjs');

const MESSAGES = {
  PIX_INDISPONIVEL: 'O Pix automático ainda não está disponível. Aguarde a ativação da loja.',
  PIX_AGUARDANDO_LOJA: 'A loja ainda precisa conferir o pedido e preparar o valor final com frete.',
  PIX_NAO_AUTORIZADO: 'Entre novamente na sua conta para acessar este pagamento.',
  PIX_REQUISICAO_INVALIDA: 'Não foi possível processar esta solicitação.',
  PIX_BANCO_INDISPONIVEL: 'O banco não respondeu. Aguarde e consulte novamente; a cobrança será a mesma.',
  PIX_RESPOSTA_INVALIDA: 'Não foi possível validar a resposta do banco. Aguarde a conferência da loja.',
  PIX_DIVERGENTE: 'O pagamento precisa de conferência da loja. A confirmação automática foi interrompida.',
  PIX_COBRANCA_ENCERRADA: 'Esta cobrança foi encerrada pelo banco. Entre em contato com a loja.',
  PIX_ERRO_INTERNO: 'Não foi possível consultar o pagamento. Tente novamente mais tarde.'
};

function createStore({ config, fetchImpl = fetch }) {
  async function call(path, token, apiKey, body) {
    let result;
    try {
      result = await fetchImpl(`${config.supabaseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { apikey: apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000), redirect: 'error'
      });
    } catch { throw new PixError('PIX_ERRO_INTERNO', 503); }
    if (!result.ok) {
      if (path === '/auth/v1/user') throw new PixError('PIX_NAO_AUTORIZADO', 401);
      throw new PixError('PIX_ERRO_INTERNO', 503);
    }
    try { return await result.json(); }
    catch { throw new PixError('PIX_ERRO_INTERNO', 503); }
  }
  return {
    async authenticate(token) {
      const user = await call('/auth/v1/user', token, config.anonKey);
      if (!user || !/^[0-9a-f-]{36}$/i.test(user.id || '')) throw new PixError('PIX_NAO_AUTORIZADO', 401);
      return user;
    },
    get: (id, token) => call('/rest/v1/rpc/jk_pix_obter', token, config.anonKey, { p_pedido_id: id }),
    rpc: (name, body) => call(`/rest/v1/rpc/${name}`, config.serviceKey, config.serviceKey, body)
  };
}

async function bodyOf(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body) > 2048) throw new PixError('PIX_REQUISICAO_INVALIDA', 400);
      try { return JSON.parse(req.body); } catch { throw new PixError('PIX_REQUISICAO_INVALIDA', 400); }
    }
    return req.body;
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 2048) throw new PixError('PIX_REQUISICAO_INVALIDA', 400);
  }
  try { return JSON.parse(body); } catch { throw new PixError('PIX_REQUISICAO_INVALIDA', 400); }
}

async function snapshot(row, qr) {
  const active = row.status === 'ativa';
  const code = active ? row.pix_copia_cola : null;
  return {
    status: row.status, total: Number(row.total), frete: Number(row.frete), desconto: Number(row.desconto),
    pix_copia_cola: code || null, expira_em: row.expira_em || null,
    qr_data_url: code ? await qr(code) : null, pago_em: row.pago_em || null
  };
}

function createPixHandler(options = {}) {
  let runtime;
  const now = options.now || (() => Date.now());
  const qr = options.qr || (code => require('qrcode').toDataURL(code, {
    type: 'image/png', errorCorrectionLevel: 'M', width: 320, margin: 4
  }));
  function getRuntime() {
    if (runtime) return runtime;
    const config = options.config || readConfig(options.env || process.env);
    runtime = { config, store: options.store || createStore({ config, fetchImpl: options.fetchImpl }),
      bank: options.bank || createBBPixClient({ config, now }) };
    return runtime;
  }
  return async function pixHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    function send(status, value) { res.statusCode = status; res.end(JSON.stringify(value)); }
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(405, { code: 'PIX_REQUISICAO_INVALIDA', message: MESSAGES.PIX_REQUISICAO_INVALIDA });
      }
      const { config, store, bank } = getRuntime();
      const origin = req.headers?.origin;
      if (origin) {
        let validOrigin = false;
        try {
          const parsed = new URL(origin);
          validOrigin = parsed.origin === origin && parsed.protocol === 'https:' &&
            (config.siteOrigin ? origin === config.siteOrigin : parsed.host === req.headers.host);
        } catch { /* Origem inválida. */ }
        if (!validOrigin) throw new PixError('PIX_REQUISICAO_INVALIDA', 403);
      }
      const authorization = req.headers?.authorization || '';
      const match = /^Bearer ([^\s]{1,20000})$/.exec(authorization);
      if (!match) throw new PixError('PIX_NAO_AUTORIZADO', 401);
      await store.authenticate(match[1]);
      const body = await bodyOf(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some(key => !['pedido_id', 'acao'].includes(key)) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.pedido_id || '') ||
          !['cobrar', 'consultar'].includes(body.acao)) throw new PixError('PIX_REQUISICAO_INVALIDA', 400);
      const id = body.pedido_id;
      let row = await store.get(id, match[1]);
      // O mesmo retorno para inexistente/sem preparo/outro dono não revela pedidos.
      if (!row) throw new PixError('PIX_AGUARDANDO_LOJA', 409);
      if (row.status === 'paga') return send(200, await snapshot(row, qr));
      if (body.acao === 'consultar' && row.status === 'pronta') return send(200, await snapshot(row, qr));
      const mayCreate = body.acao === 'cobrar' && ['pronta', 'solicitando'].includes(row.status);
      if (body.acao === 'cobrar') row = await store.rpc('jk_pix_reservar', { p_pedido_id: id });
      if (row?.status === 'paga') return send(200, await snapshot(row, qr));
      if (!row || !['solicitando', 'ativa', 'expirada'].includes(row.status)) throw new PixError('PIX_DIVERGENTE', 409);
      amount(row.total); // Só o total reservado pelo banco de dados é usado.
      let charge = await bank.getCharge(row.txid);
      if (!charge && mayCreate && row.status === 'solicitando') {
        try { charge = await bank.createCharge(row.txid, row.total); }
        catch (error) {
          // O PUT pode ter sido aceito antes de um timeout: consultar o MESMO txid.
          charge = await bank.getCharge(row.txid);
          if (!charge) throw error;
        }
      }
      if (!charge) {
        if (row.status !== 'solicitando') throw new PixError('PIX_DIVERGENTE', 409);
        return send(200, await snapshot(row, qr));
      }
      const checked = validateCharge(charge, { txid: row.txid, total: row.total, chave: config.chave }, now());
      if (checked.paid) {
        row = await store.rpc('jk_pix_confirmar', {
          p_pedido_id: id, p_txid: row.txid, p_valor: amount(row.total),
          p_end_to_end: checked.endToEndId, p_pago_em: checked.paidAt
        });
      } else {
        if (row.status !== 'expirada') {
          row = await store.rpc('jk_pix_salvar_cobranca', {
            p_pedido_id: id, p_txid: row.txid, p_codigo: checked.code, p_expira_em: checked.expiresAt
          });
        }
        if (checked.expired && row.status !== 'paga') row = await store.rpc('jk_pix_expirar', { p_pedido_id: id });
      }
      if (!row) throw new PixError('PIX_ERRO_INTERNO', 503);
      return send(200, await snapshot(row, qr));
    } catch (error) {
      const safe = error instanceof PixError && MESSAGES[error.code] ? error : new PixError('PIX_ERRO_INTERNO', 503);
      return send(safe.status, { code: safe.code, message: MESSAGES[safe.code] });
    }
  };
}

module.exports = { createPixHandler, createStore };
