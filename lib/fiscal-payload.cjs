'use strict';

const { FiscalError } = require('./fiscal-provider.cjs');
const UFS = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));
const CSOSN = new Set(['101', '102', '103', '201', '202', '203', '300', '400', '500', '900']);
const CORE_NOTE = new Set(['ref', 'referencia', 'status', 'ambiente', 'items', 'itens', 'formas_pagamento',
  'cnpj_emitente', 'cpf_emitente', 'cnpj_destinatario', 'cpf_destinatario', 'data_emissao', 'numero', 'serie',
  'chave_nfe', 'natureza_operacao', 'tipo_documento', 'presenca_comprador', 'consumidor_final',
  'valor_produtos', 'valor_total', 'valor_frete', 'valor_desconto', 'total', 'token', 'authorization']);
const CORE_ITEM = new Set(['numero_item', 'codigo_produto', 'descricao', 'quantidade_comercial', 'quantidade_tributavel',
  'valor_unitario_comercial', 'valor_unitario_tributavel', 'valor_bruto', 'valor_frete', 'valor_desconto',
  'unidade_tributavel', 'valor_total', 'total', 'ref', 'status', 'cnpj_emitente', 'items', 'itens']);

function invalid(field, message) { throw new FiscalError('FISCAL_VALIDACAO', 422, `${field}: ${message}`, field); }
function plain(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(field, 'informe um objeto JSON.');
  return value;
}
function text(value, field, min = 1, max = 120) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) invalid(field, `informe texto entre ${min} e ${max} caracteres.`);
  return value.trim();
}
function digits(value, length, field) {
  const result = text(value, field, length, length + 8).replace(/[.\/-]/g, '');
  if (!new RegExp(`^\\d{${length}}$`).test(result)) invalid(field, `informe ${length} dígitos.`);
  return result;
}
function integer(value, values, field) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || !values.includes(n)) invalid(field, `valor permitido: ${values.join(', ')}.`);
  return n;
}
function scaled(value, scale, field, zero = true) {
  const string = typeof value === 'number' ? String(value) : value;
  if (typeof string !== 'string' || !new RegExp(`^\\d{1,11}(?:\\.\\d{1,${scale}})?$`).test(string)) invalid(field, `informe número não negativo com até ${scale} casas decimais, usando ponto.`);
  const [whole, decimal = ''] = string.split('.');
  const result = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(decimal.padEnd(scale, '0'));
  if ((!zero && result === 0n) || result > 999999999999999n) invalid(field, 'valor fora do limite aceito.');
  return result;
}
function formatted(value, scale = 2) {
  const divisor = 10n ** BigInt(scale);
  return `${value / divisor}.${(value % divisor).toString().padStart(scale, '0')}`;
}
function checkExtraValue(value, field, depth = 0) {
  if (depth > 6) invalid(field, 'estrutura JSON muito profunda.');
  if (value === null) return null;
  if (typeof value === 'string') {
    if (value.length > 5000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid(field, 'texto inválido.');
    return value;
  }
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(field, 'número inválido.'); return value; }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > 1000) invalid(field, 'muitos elementos.');
    return value.map((item, i) => checkExtraValue(item, `${field}[${i}]`, depth + 1));
  }
  plain(value, field);
  const result = {};
  if (Object.keys(value).length > 200) invalid(field, 'muitos campos.');
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) invalid(`${field}.${key}`, 'nome de campo inválido.');
    result[key] = checkExtraValue(item, `${field}.${key}`, depth + 1);
  }
  return result;
}
function extras(value, blocked, field) {
  const result = checkExtraValue(value || {}, field);
  plain(result, field);
  for (const [key, item] of Object.entries(result)) {
    if (blocked.has(key) || /_(?:emitente|destinatario)$/.test(key)) invalid(`${field}.${key}`, 'campo controlado pelo servidor; não pode ser sobrescrito.');
    if (/(?:aliquota|percentual|reducao|base_calculo|quantidade|valor)/.test(key) && item !== null) {
      const precision = /aliquota|percentual|reducao|quantidade/.test(key) ? 4 : 2;
      scaled(item, precision, `${field}.${key}`);
    }
  }
  return result;
}

function apportion(total, amounts) {
  const sum = amounts.reduce((a, b) => a + b, 0n);
  if (sum === 0n) { if (total !== 0n) invalid('itens', 'não é possível ratear valores em produtos de valor zero.'); return amounts.map(() => 0n); }
  const shares = amounts.map(value => total * value / sum);
  let remainder = total - shares.reduce((a, b) => a + b, 0n);
  const order = amounts.map((value, i) => ({ i, remainder: total * value % sum }))
    .sort((a, b) => a.remainder === b.remainder ? a.i - b.i : (a.remainder > b.remainder ? -1 : 1));
  for (let i = 0; remainder > 0n; i += 1, remainder -= 1n) shares[order[i].i] += 1n;
  return shares;
}

function profileFields(profile, field) {
  const fiscal = extras(plain(profile.campos_fiscais, `${field}.campos_fiscais`), CORE_ITEM, `${field}.campos_fiscais`);
  fiscal.codigo_ncm = digits(String(fiscal.codigo_ncm ?? ''), 8, `${field}.codigo_ncm`);
  fiscal.cfop = digits(String(fiscal.cfop ?? ''), 4, `${field}.cfop`);
  fiscal.icms_origem = integer(fiscal.icms_origem, [0, 1, 2, 3, 4, 5, 6, 7, 8], `${field}.icms_origem`);
  const csosn = String(fiscal.icms_situacao_tributaria ?? '');
  if (!CSOSN.has(csosn)) invalid(`${field}.icms_situacao_tributaria`, 'informe o CSOSN do Simples Nacional validado pela contabilidade.');
  fiscal.icms_situacao_tributaria = csosn;
  if (fiscal.inclui_no_total !== undefined && String(fiscal.inclui_no_total) !== '1') invalid(`${field}.inclui_no_total`, 'este fluxo exige que os produtos componham o total.');
  for (const tax of ['pis', 'cofins']) {
    const key = `${tax}_situacao_tributaria`;
    if (!/^\d{2}$/.test(String(fiscal[key] ?? ''))) invalid(`${field}.${key}`, 'informe o CST com dois dígitos.');
    fiscal[key] = String(fiscal[key]);
    if (['01', '02'].includes(fiscal[key])) {
      for (const required of [`${tax}_base_calculo`, `${tax}_aliquota_porcentual`]) if (fiscal[required] === undefined) invalid(`${field}.${required}`, 'campo necessário para este CST; consulte a contabilidade.');
    }
    if (fiscal[key] === '03') {
      for (const required of [`${tax}_quantidade_vendida`, `${tax}_aliquota_valor`]) if (fiscal[required] === undefined) invalid(`${field}.${required}`, 'campo necessário para este CST; consulte a contabilidade.');
    }
  }
  // Não calculamos tributos por alíquotas genéricas. Valores que alteram vNF
  // precisam constar explicitamente no perfil revisado pela contabilidade.
  for (const [pattern, amountKey] of [[/^ipi_/, 'ipi_valor'], [/^ii_/, 'ii_valor'], [/^icms_.*_st$/, 'icms_valor_st']]) {
    const ratePresent = Object.entries(fiscal).some(([key, value]) => pattern.test(key) && /aliquota|percentual|margem|base_calculo|quantidade_total|valor_por_unidade|despesas_aduaneiras|valor_iof/.test(key) && value !== null && scaled(value, 4, `${field}.${key}`) > 0n);
    if (ratePresent && fiscal[amountKey] === undefined) invalid(`${field}.${amountKey}`, 'informe o valor tributário explícito; o sistema não calcula esta tributação.');
  }
  if (['201', '202', '203'].includes(csosn) && fiscal.icms_valor_st === undefined) invalid(`${field}.icms_valor_st`, 'informe o valor explícito da substituição tributária.');
  for (const tax of ['pis', 'cofins']) {
    if (fiscal[`${tax}_valor_st`] !== undefined && scaled(fiscal[`${tax}_valor_st`], 2, `${field}.${tax}_valor_st`) > 0n) integer(fiscal[`inclui_${tax}_st_no_total`], [0, 1], `${field}.inclui_${tax}_st_no_total`);
    if (String(fiscal[`inclui_${tax}_st_no_total`]) === '1' && fiscal[`${tax}_valor_st`] === undefined) invalid(`${field}.${tax}_valor_st`, 'informe o valor explícito do tributo que compõe o total.');
  }
  for (const [key, value] of Object.entries(fiscal)) {
    if (/^(?:ibs|cbs|is)_/.test(key) && /valor|aliquota|percentual/.test(key) && value !== null && scaled(value, 4, `${field}.${key}`) > 0n) {
      invalid(`${field}.${key}`, 'esta composição de IBS/CBS/IS requer validação adicional do total com o emissor antes da emissão.');
    }
    if (/^(?:fcp_valor_st|icms_fcp_valor_st|valor_ipi_devolvido|issqn_valor|valor_total_servicos)$/.test(key) && value !== null && scaled(value, 2, `${field}.${key}`) > 0n) invalid(`${field}.${key}`, 'esta composição requer adaptação validada do total antes da emissão.');
    if (/^(?:fcp_.*_st|icms_.*fcp.*_st)$/.test(key) && value !== null && scaled(value, 4, `${field}.${key}`) > 0n) invalid(`${field}.${key}`, 'a composição de FCP-ST requer adaptação validada do total antes da emissão.');
  }
  return fiscal;
}

function buildFiscalPayload(draft, config, { now = () => new Date(), environment = 'homologacao' } = {}) {
  plain(draft, 'nota'); plain(config, 'configuracao');
  const emitter = plain(config.emitente, 'emitente');
  if (emitter.uf !== 'DF') invalid('emitente.uf', 'esta configuração atende o emitente do Distrito Federal.');
  integer(emitter.regime_tributario, [1], 'emitente.regime_tributario');
  const recipient = plain(draft.destinatario, 'destinatario');
  const uf = text(recipient.uf, 'destinatario.uf', 2, 2).toUpperCase();
  if (!UFS.has(uf)) invalid('destinatario.uf', 'informe uma UF brasileira.');
  if (!['cpf', 'cnpj'].includes(recipient.tipo_documento)) invalid('destinatario.tipo_documento', 'escolha cpf ou cnpj.');
  const document = digits(recipient.documento, recipient.tipo_documento === 'cpf' ? 11 : 14, 'destinatario.documento');
  const presence = integer(draft.presenca_comprador, [1, 2, 3, 9], 'presenca_comprador');
  const finalConsumer = integer(draft.consumidor_final, [0, 1], 'consumidor_final');
  const ieIndicator = integer(recipient.indicador_ie, [1, 2, 9], 'destinatario.indicador_ie');
  if (ieIndicator === 1 && !recipient.inscricao_estadual) invalid('destinatario.inscricao_estadual', 'obrigatória para contribuinte ICMS.');
  if (!Array.isArray(config.perfis) || !config.perfis.length) invalid('configuracao.perfis', 'importe os perfis revisados pela contabilidade.');
  const profileIds = config.perfis.map((p, i) => text(p.id, `perfis[${i}].id`, 1, 80));
  if (new Set(profileIds).size !== profileIds.length) invalid('configuracao.perfis', 'há identificadores de perfil duplicados.');
  if (!Array.isArray(draft.itens) || draft.itens.length < 1 || draft.itens.length > 990) invalid('itens', 'informe entre 1 e 990 produtos.');
  const noteExtras = extras(config.campos_adicionais, CORE_NOTE, 'configuracao.campos_adicionais');
  const draftExtras = extras(draft.campos_adicionais, CORE_NOTE, 'nota.campos_adicionais');
  for (const key of Object.keys(draftExtras)) if (noteExtras[key] !== undefined && JSON.stringify(noteExtras[key]) !== JSON.stringify(draftExtras[key])) invalid(`nota.campos_adicionais.${key}`, 'não pode contrariar a configuração revisada.');
  const more = { ...noteExtras, ...draftExtras };
  for (const [key, value] of Object.entries(more)) {
    if (/^(?:ibs|cbs|is)_/.test(key) && /valor|aliquota|percentual/.test(key) && value !== null && scaled(value, 4, `campos_adicionais.${key}`) > 0n) invalid(`campos_adicionais.${key}`, 'esta composição requer validação adicional do total com o emissor.');
    if (/^(?:valor_ipi_devolvido|valor_total_servicos|fcp_valor_total_st)$/.test(key) && value !== null && scaled(value, 2, `campos_adicionais.${key}`) > 0n) invalid(`campos_adicionais.${key}`, 'esta composição requer adaptação validada do total antes da emissão.');
  }
  const purpose = integer(more.finalidade_emissao, [1, 2, 3, 4], 'campos_adicionais.finalidade_emissao');
  const shippingMode = integer(more.modalidade_frete, [0, 1, 2, 3, 4, 9], 'campos_adicionais.modalidade_frete');
  const destination = uf === emitter.uf ? 1 : 2;
  if (more.local_destino !== undefined && integer(more.local_destino, [1, 2], 'campos_adicionais.local_destino') !== destination) invalid('campos_adicionais.local_destino', 'diverge da UF de destino.');
  const grossAmounts = [];
  const bindings = [];
  const items = draft.itens.map((input, i) => {
    const field = `itens[${i}]`;
    plain(input, field);
    const profile = config.perfis.find(p => p.id === input.perfil_id);
    if (!profile) invalid(`${field}.perfil_id`, 'selecione um perfil cadastrado pela contabilidade.');
    for (const [scope, wanted] of [['uf_destino', uf], ['tipo_documento', recipient.tipo_documento], ['presenca_comprador', presence]]) {
      if (!Array.isArray(profile[scope]) || !profile[scope].map(value => scope === 'presenca_comprador' ? Number(value) : value).includes(wanted)) invalid(`${field}.perfil_id`, `o perfil não foi aprovado para ${scope}=${wanted}.`);
    }
    const fiscal = profileFields(profile, `perfis.${profile.id}`);
    const needsBinding = Object.entries(fiscal).some(([key, value]) =>
      /valor|base_calculo/.test(key) && !/aliquota|percentual|reducao|margem|modalidade/.test(key) &&
      value !== null && scaled(value, 2, `perfis.${profile.id}.${key}`) > 0n);
    bindings.push({ profile, needsBinding });
    if (input.campos_fiscais !== undefined && JSON.stringify(input.campos_fiscais) !== JSON.stringify(profile.campos_fiscais)) invalid(`${field}.campos_fiscais`, 'tributação divergente do perfil; use apenas perfil_id.');
    if (!fiscal.cfop.startsWith(destination === 1 ? '5' : '6')) invalid(`${field}.cfop`, 'o CFOP de saída diverge da UF de destino.');
    const unit = text(input.unidade, `${field}.unidade`, 1, 6);
    if (fiscal.unidade_comercial !== undefined && fiscal.unidade_comercial !== unit) invalid(`${field}.unidade`, 'diverge da unidade aprovada no perfil.');
    const quantity = scaled(input.quantidade, 4, `${field}.quantidade`, false);
    const unitPrice = scaled(input.preco_unitario, 4, `${field}.preco_unitario`);
    const gross = (quantity * unitPrice + 500000n) / 1000000n;
    if (gross > 9999999999999n) invalid(`${field}.preco_unitario`, 'valor do item excede o limite.');
    grossAmounts.push(gross);
    return { ...fiscal, numero_item: i + 1, codigo_produto: text(input.codigo, `${field}.codigo`, 1, 60),
      descricao: text(input.descricao, `${field}.descricao`, 1, 120), unidade_comercial: unit, unidade_tributavel: unit,
      quantidade_comercial: formatted(quantity, 4), quantidade_tributavel: formatted(quantity, 4),
      valor_unitario_comercial: formatted(unitPrice, 4), valor_unitario_tributavel: formatted(unitPrice, 4),
      valor_bruto: formatted(gross), inclui_no_total: 1 };
  });
  const products = grossAmounts.reduce((a, b) => a + b, 0n);
  const shipping = scaled(draft.frete, 2, 'frete');
  const discount = scaled(draft.desconto, 2, 'desconto');
  const insurance = more.valor_seguro === undefined ? 0n : scaled(more.valor_seguro, 2, 'campos_adicionais.valor_seguro');
  const other = more.valor_outras_despesas === undefined ? 0n : scaled(more.valor_outras_despesas, 2, 'campos_adicionais.valor_outras_despesas');
  if (discount > products) invalid('desconto', 'não pode superar o valor dos produtos.');
  if (shipping > 0n && shippingMode === 9) invalid('campos_adicionais.modalidade_frete', 'não pode indicar sem frete quando há valor de frete.');
  const taxes = { icms_st: 0n, ipi: 0n, ii: 0n, pis_st: 0n, cofins_st: 0n, icms_desonerado_dedutivel: 0n };
  for (const item of items) {
    for (const [name, field] of [['icms_st', 'icms_valor_st'], ['ipi', 'ipi_valor'], ['ii', 'ii_valor']]) if (item[field] !== undefined && item[field] !== null) taxes[name] += scaled(item[field], 2, field);
    for (const tax of ['pis', 'cofins']) if (String(item[`inclui_${tax}_st_no_total`]) === '1') taxes[`${tax}_st`] += scaled(item[`${tax}_valor_st`], 2, `${tax}_valor_st`);
    if (String(item.icms_deducao_desoneracao) === '1') {
      if (item.icms_valor_desonerado === undefined) invalid('icms_valor_desonerado', 'informe o valor explícito para dedução.');
      taxes.icms_desonerado_dedutivel += scaled(item.icms_valor_desonerado, 2, 'icms_valor_desonerado');
    }
  }
  // Totais de imposto fornecidos manualmente devem bater com os itens, sem
  // substituir a composição calculada. O emissor valida a regra fiscal completa.
  for (const [field, expected] of [['icms_valor_total_st', taxes.icms_st], ['valor_ipi', taxes.ipi], ['valor_total_ii', taxes.ii]]) {
    if (more[field] !== undefined && scaled(more[field], 2, `campos_adicionais.${field}`) !== expected) invalid(`campos_adicionais.${field}`, 'diverge dos valores explícitos nos itens.');
  }
  const total = products + shipping + insurance + other - discount + taxes.icms_st + taxes.ipi + taxes.ii + taxes.pis_st + taxes.cofins_st - taxes.icms_desonerado_dedutivel;
  if (total <= 0n || total > 9999999999999n) invalid('total', 'o total fiscal precisa ser positivo e respeitar o limite do documento.');
  const payment = plain(draft.pagamento, 'pagamento');
  const form = text(payment.forma, 'pagamento.forma', 2, 2);
  if (!/^(?:0[1-5]|1[0-9]|2[0-4]|90|91|99)$/.test(form)) invalid('pagamento.forma', 'informe o código de pagamento validado pela contabilidade.');
  if (form === '90') invalid('pagamento.forma', 'sem pagamento não é compatível com esta venda com valor positivo.');
  if (payment.valor !== undefined && scaled(payment.valor, 2, 'pagamento.valor') !== total) invalid('pagamento.valor', 'diverge do total fiscal; revise o pagamento.');
  const paymentPayload = { forma_pagamento: form,
    indicador_pagamento: integer(payment.indicador_pagamento, [0, 1], 'pagamento.indicador_pagamento'), valor_pagamento: formatted(total) };
  if (payment.tipo_integracao !== undefined && payment.tipo_integracao !== '') paymentPayload.tipo_integracao = integer(payment.tipo_integracao, [1, 2], 'pagamento.tipo_integracao');
  for (const field of ['cnpj_credenciadora', 'bandeira_operadora', 'numero_autorizacao', 'descricao_pagamento']) {
    if (payment[field] !== undefined && payment[field] !== '') paymentPayload[field] = text(payment[field], `pagamento.${field}`, 1, field === 'numero_autorizacao' ? 128 : 60);
  }
  if (form === '99' && !paymentPayload.descricao_pagamento) invalid('pagamento.descricao_pagamento', 'descreva o meio de pagamento Outros.');
  if (['03', '04'].includes(form) && paymentPayload.tipo_integracao === undefined) invalid('pagamento.tipo_integracao', 'informe o tipo de integração do cartão.');
  if (paymentPayload.tipo_integracao === 1 && (!paymentPayload.cnpj_credenciadora || !paymentPayload.numero_autorizacao)) invalid('pagamento', 'pagamento integrado exige CNPJ da credenciadora e número da autorização.');
  if (paymentPayload.cnpj_credenciadora) paymentPayload.cnpj_credenciadora = digits(paymentPayload.cnpj_credenciadora, 14, 'pagamento.cnpj_credenciadora');
  const freightShares = apportion(shipping, grossAmounts);
  const discountShares = apportion(discount, grossAmounts);
  const insuranceShares = apportion(insurance, grossAmounts);
  const otherShares = apportion(other, grossAmounts);
  items.forEach((item, i) => {
    Object.assign(item, { valor_frete: formatted(freightShares[i]), valor_desconto: formatted(discountShares[i]),
      valor_seguro: formatted(insuranceShares[i]), valor_outras_despesas: formatted(otherShares[i]) });
    const { profile, needsBinding } = bindings[i];
    if (needsBinding) {
      const field = `perfis.${profile.id}.valores_vinculados`;
      const approved = plain(profile.valores_vinculados, field);
      if (approved.codigo !== item.codigo_produto) invalid(`${field}.codigo`, 'perfil monetário não aprovado para este produto.');
      for (const [key, actual, scale] of [['quantidade', item.quantidade_comercial, 4],
        ['preco_unitario', item.valor_unitario_comercial, 4], ['frete', item.valor_frete, 2],
        ['desconto', item.valor_desconto, 2], ['seguro', item.valor_seguro, 2],
        ['outras_despesas', item.valor_outras_despesas, 2]]) {
        if (scaled(approved[key], scale, `${field}.${key}`) !== scaled(actual, scale, `${field}.${key}`)) {
          invalid(`${field}.${key}`, 'os valores da operação mudaram; solicite à contabilidade um perfil revisado para estes valores.');
        }
      }
    }
  });
  const payload = { ...more, finalidade_emissao: purpose, modalidade_frete: shippingMode, local_destino: destination,
    natureza_operacao: text(draft.natureza_operacao, 'natureza_operacao', 1, 60), data_emissao: now().toISOString(),
    tipo_documento: 1, presenca_comprador: presence, consumidor_final: finalConsumer,
    cnpj_emitente: digits(emitter.cnpj, 14, 'emitente.cnpj'), nome_emitente: text(emitter.nome, 'emitente.nome', 2, 60),
    inscricao_estadual_emitente: text(emitter.inscricao_estadual, 'emitente.inscricao_estadual', 2, 20),
    regime_tributario_emitente: 1, uf_emitente: 'DF',
    nome_destinatario: environment === 'homologacao' ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : text(recipient.nome, 'destinatario.nome', 2, 60),
    [recipient.tipo_documento === 'cpf' ? 'cpf_destinatario' : 'cnpj_destinatario']: document,
    indicador_inscricao_estadual_destinatario: ieIndicator,
    uf_destinatario: uf, codigo_municipio_destinatario: digits(recipient.codigo_municipio, 7, 'destinatario.codigo_municipio'),
    valor_produtos: formatted(products), valor_frete: formatted(shipping), valor_desconto: formatted(discount),
    valor_seguro: formatted(insurance), valor_outras_despesas: formatted(other),
    icms_valor_total_st: formatted(taxes.icms_st), valor_ipi: formatted(taxes.ipi), valor_total_ii: formatted(taxes.ii),
    valor_total: formatted(total), items, formas_pagamento: [paymentPayload] };
  text(recipient.nome, 'destinatario.nome', 2, 60);
  for (const [suffix, input] of [['emitente', emitter], ['destinatario', recipient]]) {
    for (const field of ['logradouro', 'numero', 'bairro', 'municipio']) payload[`${field}_${suffix}`] = text(input[field], `${suffix}.${field}`, 1, field === 'numero' ? 60 : 60);
    payload[`cep_${suffix}`] = digits(input.cep, 8, `${suffix}.cep`);
  }
  if (recipient.inscricao_estadual) payload.inscricao_estadual_destinatario = text(recipient.inscricao_estadual, 'destinatario.inscricao_estadual', 2, 20);
  if (recipient.email) {
    const email = text(recipient.email, 'destinatario.email', 3, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('destinatario.email', 'e-mail inválido.');
    payload.email_destinatario = email;
  }
  return { payload, total: formatted(total), componentes: { produtos: formatted(products), frete: formatted(shipping),
    desconto: formatted(discount), seguro: formatted(insurance), outras_despesas: formatted(other),
    ...Object.fromEntries(Object.entries(taxes).map(([key, value]) => [key, formatted(value)])) } };
}

module.exports = { buildFiscalPayload, FiscalError, scaled, formatted, apportion };
