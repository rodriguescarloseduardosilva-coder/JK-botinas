'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFiscalPayload, scaled, apportion } = require('../lib/fiscal-payload.cjs');
const NOW = new Date('2026-10-26T18:00:00Z');
function configuration() { return { emitente: { cnpj: '12345678000123', nome: 'JK BOTINAS LTDA', inscricao_estadual: '123456789',
  logradouro: 'Rua Teste', numero: '1', bairro: 'Centro', municipio: 'Brasilia', uf: 'DF', cep: '70000000', regime_tributario: 1 },
  perfis: [{ id: 'teste', nome: 'Perfil fornecido pela contabilidade para teste de software', uf_destino: ['DF', 'GO'], tipo_documento: ['cpf','cnpj'], presenca_comprador: [1,2,3,9],
    campos_fiscais: { codigo_ncm: '64039990', cfop: '5102', icms_origem: 0, icms_situacao_tributaria: '102', pis_situacao_tributaria: '07', cofins_situacao_tributaria: '07', unidade_comercial: 'PAR' } }],
  campos_adicionais: { finalidade_emissao: 1, modalidade_frete: 0 } }; }
function draft() { return { config_versao: 1, destinatario: { nome: 'Cliente de teste', tipo_documento: 'cpf', documento: '12345678901', indicador_ie: 9,
  logradouro: 'Rua Cliente', numero: '2', bairro: 'Centro', municipio: 'Brasilia', codigo_municipio: '5300108', uf: 'DF', cep: '70000000' },
  itens: [{ codigo: 'BOT1', descricao: 'Produto de teste de integração', unidade: 'PAR', quantidade: '1.0000', preco_unitario: '100.0000', perfil_id: 'teste' }],
  natureza_operacao: 'Venda', presenca_comprador: 1, consumidor_final: 1, frete: '10.00', desconto: '1.00', pagamento: { forma: '01', indicador_pagamento: 0 }, campos_adicionais: {} }; }
function build(data = draft(), config = configuration(), environment = 'homologacao') { return buildFiscalPayload(data, config, { now: () => NOW, environment }); }

test('payload recalcula total e pagamento, usa perfil fiscal completo e nome de homologação', () => {
  const result = build();
  assert.equal(result.total, '109.00');
  assert.equal(result.payload.valor_produtos, '100.00');
  assert.equal(result.payload.formas_pagamento[0].valor_pagamento, '109.00');
  assert.equal(result.payload.items[0].codigo_ncm, '64039990');
  assert.equal(result.payload.data_emissao, NOW.toISOString());
  assert.match(result.payload.nome_destinatario, /SEM VALOR FISCAL/);
  assert.equal(build(draft(), configuration(), 'producao').payload.nome_destinatario, 'Cliente de teste');
});

test('decimal exato com quatro casas e arredondamento de centavos por item', () => {
  const data = draft(); data.frete = '0'; data.desconto = '0';
  data.itens[0].quantidade = '100'; data.itens[0].preco_unitario = '0.4723';
  assert.equal(build(data).total, '47.23');
  data.itens[0].quantidade = '1'; data.itens[0].preco_unitario = '1.0050';
  assert.equal(build(data).total, '1.01');
  for (const value of [0.30000000000000004, '1e2', '1,00', '-1', '1.00001']) assert.throws(() => scaled(value, 4, 'valor'));
});

test('frete e desconto são rateados sem perder ou criar centavos', () => {
  const data = draft(); data.frete = '0.01'; data.desconto = '0.02';
  data.itens = Array.from({ length: 3 }, (_, i) => ({ ...data.itens[0], codigo: String(i), preco_unitario: '1' }));
  const result = build(data);
  assert.equal(result.total, '2.99');
  assert.deepEqual(result.payload.items.map(i => i.valor_frete), ['0.01','0.00','0.00']);
  assert.deepEqual(result.payload.items.map(i => i.valor_desconto), ['0.01','0.01','0.00']);
  assert.deepEqual(apportion(2n, [1n,1n,1n]), [1n,1n,0n]);
});

test('nenhum NCM/CFOP/CSOSN/CST é presumido ou sobrescrito por rascunho', () => {
  for (const key of ['codigo_ncm','cfop','icms_origem','icms_situacao_tributaria','pis_situacao_tributaria','cofins_situacao_tributaria']) {
    const config = configuration(); delete config.perfis[0].campos_fiscais[key];
    assert.throws(() => build(draft(), config), { code: 'FISCAL_VALIDACAO' });
  }
  const data = draft(); data.itens[0].campos_fiscais = { codigo_ncm: '99999999' };
  assert.throws(() => build(data), { field: 'itens[0].campos_fiscais' });
  data.itens[0].campos_fiscais = undefined; data.campos_adicionais.valor_total = '0.01';
  assert.throws(() => build(data), { field: 'nota.campos_adicionais.valor_total' });
});

test('perfil precisa aprovar UF, documento e canal; CFOP acompanha destino', () => {
  const data = draft(); data.destinatario.uf = 'GO';
  assert.throws(() => build(data), { field: 'itens[0].cfop' });
  const config = configuration(); config.perfis[0].campos_fiscais.cfop = '6102';
  assert.equal(build(data, config).payload.local_destino, 2);
  config.perfis[0].uf_destino = ['DF'];
  assert.throws(() => build(data, config), { field: 'itens[0].perfil_id' });
});

test('tributos explícitos que compõem o total entram na revisão sem deduzir alíquotas', () => {
  const config = configuration();
  config.perfis[0].valores_vinculados = { codigo: 'BOT1', quantidade: '1', preco_unitario: '100', frete: '10', desconto: '1', seguro: '0', outras_despesas: '0' };
  Object.assign(config.perfis[0].campos_fiscais, { icms_valor_st: '2.30', ipi_valor: '1.20',
    inclui_pis_st_no_total: 1, pis_valor_st: '0.50', inclui_cofins_st_no_total: 1, cofins_valor_st: '0.25' });
  const result = build(draft(), config);
  assert.equal(result.total, '113.25');
  assert.equal(result.componentes.icms_st, '2.30');
  assert.equal(result.payload.formas_pagamento[0].valor_pagamento, '113.25');
});

test('tributos monetários só podem ser usados nos valores exatos aprovados pela contabilidade', () => {
  const config = configuration(); config.perfis[0].campos_fiscais.pis_base_calculo = '100.00';
  assert.throws(() => build(draft(), config), { field: 'perfis.teste.valores_vinculados' });
  config.perfis[0].valores_vinculados = { codigo: 'BOT1', quantidade: '1', preco_unitario: '100', frete: '10', desconto: '1', seguro: '0', outras_despesas: '0' };
  assert.equal(build(draft(), config).total, '109.00');
  for (const change of [data => { data.itens[0].quantidade = '2'; }, data => { data.itens[0].preco_unitario = '101'; },
    data => { data.frete = '11'; }, data => { data.desconto = '2'; },
    data => { data.itens.push({ ...data.itens[0], codigo: 'BOT2' }); }]) {
    const data = draft(); change(data);
    assert.throws(() => build(data, config), error => error.code === 'FISCAL_VALIDACAO' && /valores_vinculados/.test(error.field));
  }
});

test('ST positiva sem valor explícito e composições tributárias não cobertas bloqueiam emissão', () => {
  for (const fields of [{ icms_situacao_tributaria: '900', icms_aliquota_st: '18.00' },
    { icms_situacao_tributaria: '900', icms_margem_valor_adicionado_st: '40.00' },
    { icms_situacao_tributaria: '201' }, { ipi_aliquota: '5' }, { inclui_pis_st_no_total: 1 },
    { ibs_aliquota: '0.1' }, { fcp_valor_st: '1.00' }, { fcp_percentual_st: '2.00' },
    { ipi_quantidade_total: '1', ipi_valor_por_unidade_tributavel: '0.50' },
    { icms_fcp_valor_st: '1.00' }, { pis_valor_st: '1.00' }]) {
    const config = configuration(); Object.assign(config.perfis[0].campos_fiscais, fields);
    assert.throws(() => build(draft(), config), { code: 'FISCAL_VALIDACAO' });
  }
});

test('campos obrigatórios, pagamento e configuração societária são validados por campo', () => {
  const cases = [data => { data.destinatario.codigo_municipio = ''; }, data => { data.itens[0].quantidade = '0'; },
    data => { data.itens[0].unidade = ''; }, data => { data.desconto = '1000'; },
    data => { data.pagamento.valor = '1'; }, data => { data.pagamento.forma = '03'; },
    data => { data.pagamento.forma = '99'; }, data => { data.destinatario.indicador_ie = 1; }];
  for (const change of cases) { const data = draft(); change(data); assert.throws(() => build(data), error => error.code === 'FISCAL_VALIDACAO' && !!error.field); }
  const config = configuration(); config.emitente.regime_tributario = 3;
  assert.throws(() => build(draft(), config), { field: 'emitente.regime_tributario' });
});
