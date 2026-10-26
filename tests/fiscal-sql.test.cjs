'use strict';

// Executa a migração real. Não cria tabelas de pedidos, Pix ou estoque e não
// acessa Supabase/SEFAZ: autenticação é representada por JWTs de teste locais.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    ({ PGlite } = require(join(__dirname, '../../jk-botinas/node_modules/@electric-sql/pglite')));
}

const ADMIN = '10000000-0000-4000-8000-000000000001';
const CUSTOMER = '10000000-0000-4000-8000-000000000002';
const KEY = '5'.repeat(44); // Validação estrutural; não é autorização fiscal real.
const DRAFT = { config_versao: 1, destinatario: { nome: 'Cliente de teste', cpf: '98765432109' }, itens: [{ codigo: 'SKU-1', quantidade: 1 }] };
const PAYLOAD = { natureza_operacao: 'VENDA', nome_destinatario: 'Cliente de teste', cpf_destinatario: '98765432109', itens: [{ codigo_produto: 'SKU-1' }] };
const AUTHORIZED = { chave: KEY, numero: '123', serie: '1' };
let db;
let nextId = 1;
const id = () => '30000000-0000-4000-8000-' + String(nextId++).padStart(12, '0');

async function identity(role, claims, action) {
    assert.ok(['postgres','authenticated','anon','service_role'].includes(role));
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)]);
    await db.exec('set role ' + role);
    try { return await action(); }
    finally { await db.exec('reset role'); }
}
const admin = action => identity('authenticated', { role: 'authenticated', sub: ADMIN, app_metadata: { loja_admin: true } }, action);
const customer = action => identity('authenticated', { role: 'authenticated', sub: CUSTOMER, user_metadata: { loja_admin: true } }, action);
const service = action => identity('service_role', { role: 'service_role' }, action);
const root = action => identity('postgres', { role: 'postgres' }, action);
async function rpc(name, values = []) {
    assert.match(name, /^jk_nf_[a-z_]+$/);
    const result = await db.query(`select public.${name}(${values.map((_,i) => '$' + (i+1)).join(',')}) as result`, values);
    return result.rows[0].result;
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);
const save = (noteId, origin = 'loja', data = DRAFT, version = 0, order = null) => admin(() => rpc('jk_nf_salvar_rascunho', [noteId,origin,order,data,version]));
const reserve = (note, payload = PAYLOAD, environment = 'homologacao', version = note.versao) => service(() => rpc('jk_nf_reservar', [note.id,version,payload,environment]));
const register = (note, status, result = {}, options = {}) => service(() => rpc('jk_nf_registrar', [
    note.id, options.ambiente === undefined ? note.ambiente : options.ambiente,
    options.referencia === undefined ? note.referencia : options.referencia,
    status,result,options.versao === undefined ? note.versao : options.versao
]));
async function draft(origin = 'loja') { return save(id(),origin); }
async function reserved() { return reserve(await draft()); }
async function events(noteId) {
    return (await admin(() => db.query('select * from public.jk_nf_eventos where nota_id=$1 order by id', [noteId]))).rows;
}

before(async () => {
    db = new PGlite();
    await db.exec(`
        create role anon noinherit;
        create role authenticated noinherit;
        create role service_role noinherit bypassrls;
        create schema auth;
        grant usage on schema public,auth to anon,authenticated,service_role;
        create function auth.jwt() returns jsonb language sql stable as
            $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
        create function auth.uid() returns uuid language sql stable as
            $$ select nullif(auth.jwt()->>'sub','')::uuid $$;
        create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    `);
    await db.exec(readFileSync(join(__dirname,'../supabase/migrations/20261026_notas_fiscais.sql'),'utf8'));
});
after(async () => { if (db) await db.close(); });

test('migração funciona sem qualquer tabela ou RPC legado', async () => {
    const { rows: [r] } = await db.query("select to_regclass('public.jk_pedidos') as pedidos,to_regclass('public.jk_pix_cobrancas') as pix,to_regprocedure('public.jk_e_admin()') as admin_legado");
    assert.deepEqual(r,{ pedidos: null,pix: null,admin_legado: null });
    assert.equal((await draft()).status,'rascunho');
});

test('autorização exige role, uid e boolean verdadeiro em app_metadata', async () => {
    assert.equal(await admin(() => rpc('jk_nf_e_admin')),true);
    assert.equal(await customer(() => rpc('jk_nf_e_admin')),false);
    for (const claims of [
        {}, { role: 'authenticated',app_metadata: { loja_admin: true } },
        { role: 'service_role',sub: ADMIN,app_metadata: { loja_admin: true } },
        { role: 'authenticated',sub: ADMIN,app_metadata: { loja_admin: 'true' } }
    ]) {
        assert.equal(await identity('authenticated',claims,() => rpc('jk_nf_e_admin')),false);
    }
});

test('ACL revoga escrita de tabelas e separa RPCs administrativas e de servidor', async () => {
    for (const table of ['jk_nf_config','jk_notas_fiscais','jk_nf_eventos']) {
        const { rows: [r] } = await db.query(`select
            has_table_privilege('authenticated',$1,'SELECT') as leitura,
            has_table_privilege('authenticated',$1,'INSERT,UPDATE,DELETE') as escrita,
            has_table_privilege('service_role',$1,'INSERT,UPDATE,DELETE') as escrita_servidor,
            has_table_privilege('anon',$1,'SELECT') as anonimo`, ['public.' + table]);
        assert.deepEqual(r,{ leitura: true,escrita: false,escrita_servidor: false,anonimo: false });
    }
    const { rows: [r] } = await db.query(`select
        has_function_privilege('authenticated','public.jk_nf_salvar_config(jsonb)','EXECUTE') as admin,
        has_function_privilege('authenticated','public.jk_nf_reservar(uuid,integer,jsonb,text)','EXECUTE') as reserva_cliente,
        has_function_privilege('service_role','public.jk_nf_reservar(uuid,integer,jsonb,text)','EXECUTE') as reserva_servidor,
        has_function_privilege('anon','public.jk_nf_salvar_config(jsonb)','EXECUTE') as anonimo,
        has_function_privilege('authenticated','public.jk_nf_eventos_imutaveis()','EXECUTE') as trigger_publico`);
    assert.deepEqual(r,{ admin: true,reserva_cliente: false,reserva_servidor: true,anonimo: false,trigger_publico: false });
});

test('configuração é singleton administrativo e cada salvamento avança versão', async () => {
    const data = { empresa: { cnpj: '00000000000000',uf: 'DF' },perfis: [{ id: 'perfil-1',nome: 'Definir com a contabilidade' }] };
    const first = await admin(() => rpc('jk_nf_salvar_config',[data]));
    const second = await admin(() => rpc('jk_nf_salvar_config',[data]));
    assert.equal(first.id,true);
    assert.equal(second.versao,first.versao+1);
    assert.deepEqual(second.dados,data);
    assert.equal((await admin(() => db.query('select count(*) as n from public.jk_nf_config'))).rows[0].n,1);
    await rejectsCode(customer(() => rpc('jk_nf_salvar_config',[data])),'42501');
});

test('credenciais aninhadas, certificados e cabeçalhos são recusados; chave fiscal permanece permitida', async () => {
    for (const secret of [{ token: 'segredo' },{ empresa: { client_secret: 'segredo' } },{ perfis: [{ api_key: 'segredo' }] },{ headers: { Authorization: 'Basic segredo' } },{ texto: '-----BEGIN PRIVATE KEY-----abc' }]) {
        await rejectsCode(admin(() => rpc('jk_nf_salvar_config',[secret])),'22023');
        await rejectsCode(save(id(),'loja',secret),'22023');
    }
    assert.equal((await save(id(),'loja',{ chave: KEY })).dados.chave,KEY);
    const note = await draft();
    await rejectsCode(reserve(note,{ itens: [{ access_token: 'segredo' }] }),'22023');
});

test('rascunhos aceitam site, loja e WhatsApp sem exigir pedido relacionado', async () => {
    for (const origin of ['site','loja','whatsapp']) {
        const note = await draft(origin);
        assert.equal(note.origem,origin);
        assert.equal(note.pedido_origem,null);
        assert.equal(note.versao,1);
        assert.equal(note.referencia,'jk' + note.id.replaceAll('-',''));
        assert.equal(note.snapshot,null);
    }
    const linked = await save(id(),'site',DRAFT,0,'pedido-externo-sem-FK');
    assert.equal(linked.pedido_origem,'pedido-externo-sem-FK');
    await rejectsCode(save(id(),'outro'),'22023');
    await rejectsCode(save(id(),'loja',DRAFT,1),'40001');
});

test('edição otimista impede sobrescrever rascunho e duplicar criação', async () => {
    const note = await draft();
    const changed = await save(note.id,'whatsapp',{ ...DRAFT,observacao: 'Revisado' },note.versao);
    assert.equal(changed.versao,2);
    await rejectsCode(save(note.id,'loja',DRAFT,note.versao),'40001');
    await rejectsCode(save(note.id),'40001');
    assert.equal((await admin(() => db.query('select dados from public.jk_notas_fiscais where id=$1',[note.id]))).rows[0].dados.observacao,'Revisado');
});

test('RLS oculta notas, configuração e auditoria de cliente comum', async () => {
    await draft();
    for (const table of ['jk_nf_config','jk_notas_fiscais','jk_nf_eventos']) {
        assert.equal((await customer(() => db.query('select * from public.' + table))).rows.length,0);
        assert.ok((await admin(() => db.query('select * from public.' + table))).rows.length > 0);
    }
    await rejectsCode(customer(() => db.query("update public.jk_notas_fiscais set status='autorizada'")),'42501');
    await rejectsCode(identity('anon',{},() => db.query('select * from public.jk_notas_fiscais')),'42501');
});

test('uma única reserva pode enviar; retries concorrentes preservam snapshot e versão', async () => {
    const note = await draft();
    const results = await service(() => Promise.all([
        rpc('jk_nf_reservar',[note.id,note.versao,PAYLOAD,'homologacao']),
        rpc('jk_nf_reservar',[note.id,note.versao,{ alterado: true },'homologacao'])
    ]));
    assert.equal(results.filter(r => r.pode_enviar).length,1);
    assert.equal(results[0].versao,note.versao+1);
    assert.deepEqual(results[1].snapshot,PAYLOAD);
    const count = (await events(note.id)).length;
    const retry = await reserve(note,null,'homologacao',0);
    assert.equal(retry.pode_enviar,false);
    assert.equal(retry.versao,results[0].versao);
    assert.deepEqual(retry.snapshot,PAYLOAD);
    assert.equal((await events(note.id)).length,count);
});

test('reserva exige versão atual e resultado exige JWT service_role mesmo com privilégio SQL', async () => {
    const note = await draft();
    await rejectsCode(reserve(note,PAYLOAD,'homologacao',999),'40001');
    const args = [note.id,note.versao,PAYLOAD,'homologacao'];
    await rejectsCode(admin(() => rpc('jk_nf_reservar',args)),'42501');
    await rejectsCode(identity('postgres',{ role: 'authenticated',sub: ADMIN,app_metadata: { loja_admin: true } },() => rpc('jk_nf_reservar',args)),'42501');
    await rejectsCode(identity('postgres',{},() => rpc('jk_nf_reservar',args)),'42501');
});

test('ambiente e referência segregam resultados e não mudam após primeira reserva', async () => {
    const note = await reserved();
    await rejectsCode(reserve(note,PAYLOAD,'producao'),'22023');
    await rejectsCode(register(note,'processando',{}, { ambiente: 'producao' }),'22023');
    await rejectsCode(register(note,'processando',{}, { ambiente: null }),'22023');
    await rejectsCode(register(note,'processando',{}, { referencia: 'outra-ref' }),'22023');
    await rejectsCode(register(note,'processando',{}, { versao: note.versao-1 }),'40001');
});

test('autorização exige chave 44 dígitos e número/série válidos; protocolo é opcional', async () => {
    const note = await reserved();
    for (const result of [{}, { chave: KEY }, { ...AUTHORIZED,chave: 'abc' },{ ...AUTHORIZED,numero: '0' },{ ...AUTHORIZED,serie: null },{ ...AUTHORIZED,chave: '5'.repeat(43) }]) {
        await rejectsCode(register(note,'autorizada',result),'22023');
    }
    const authorized = await register(note,'autorizada',AUTHORIZED);
    assert.equal(authorized.status,'autorizada');
    assert.equal(authorized.protocolo,null);
    assert.equal(authorized.chave,KEY);
});

test('autorizada não regride e cancelada é terminal', async () => {
    let note = await reserved();
    note = await register(note,'processando');
    note = await register(note,'autorizada',AUTHORIZED);
    const original = note;
    const count = (await events(note.id)).length;
    assert.deepEqual(await register(note,'processando'),original);
    assert.deepEqual(await register(note,'rejeitada',{ erro: 'Resultado antigo' }),original);
    assert.equal((await events(note.id)).length,count);
    await rejectsCode(register(note,'autorizada',{ ...AUTHORIZED,chave: '6'.repeat(44) }),'22023');
    note = await register(note,'cancelada',{});
    assert.equal(note.status,'cancelada');
    assert.equal(note.chave,KEY);
    assert.deepEqual(await register(note,'autorizada',AUTHORIZED),note);
    assert.equal((await reserve(note)).pode_enviar,false);
});

test('cancelamento não pode nascer de rascunho, envio ou processamento', async () => {
    const raw = await draft();
    await rejectsCode(register(raw,'cancelada',AUTHORIZED),'22023');
    const note = await reserve(raw);
    await rejectsCode(register(note,'cancelada',AUTHORIZED),'22023');
    await register(note,'processando');
    await rejectsCode(register(note,'cancelada',AUTHORIZED),'22023');
});

test('correção de rejeitada troca snapshot só na nova reserva e recusa callback antigo', async () => {
    const first = await reserved();
    const rejected = await register(first,'rejeitada',{ erro: 'Corrigir informação fiscal' });
    await rejectsCode(register(rejected,'processando'),'22023');
    const edited = await save(first.id,'whatsapp',{ ...DRAFT,observacao: 'Corrigido' },rejected.versao);
    assert.equal(edited.status,'rascunho');
    assert.equal(edited.versao,rejected.versao+1);
    assert.deepEqual(edited.snapshot,PAYLOAD);
    const correctedPayload = { ...PAYLOAD,natureza_operacao: 'VENDA CORRIGIDA' };
    const second = await reserve(edited,correctedPayload);
    assert.equal(second.versao,edited.versao+1);
    assert.equal(second.referencia,first.referencia);
    assert.equal(second.ambiente,first.ambiente);
    assert.deepEqual(second.snapshot,correctedPayload);
    await rejectsCode(register(first,'rejeitada',{ erro: 'Atrasado' }),'40001');
    await rejectsCode(register(first,'autorizada',AUTHORIZED),'40001');
    assert.equal((await register(second,'autorizada',AUTHORIZED)).status,'autorizada');
    const audit = (await events(first.id)).filter(e => e.evento === 'reservada');
    assert.equal(audit.length,2);
    assert.equal(audit[1].detalhes.snapshot_anterior_sha256,audit[0].detalhes.snapshot_sha256);
});

test('reenvio após rejeição sem editar também recebe geração própria', async () => {
    const first = await reserved();
    const rejected = await register(first,'rejeitada',{ erro: 'Falha corrigível no emissor' });
    const second = await reserve(rejected);
    assert.equal(second.versao,first.versao+1);
    assert.equal(second.pode_enviar,true);
    await rejectsCode(register(first,'rejeitada',{ erro: 'Resposta anterior' }),'40001');
});

test('estados em andamento impedem edição e mantêm o snapshot apesar de nova configuração', async () => {
    const note = await reserved();
    await rejectsCode(save(note.id,'loja',{ outro: true },note.versao),'22023');
    await admin(() => rpc('jk_nf_salvar_config',[{ empresa: { nome: 'Atualizada' } }]));
    const retry = await reserve(note,{ novo: true });
    assert.deepEqual(retry.snapshot,note.snapshot);
    assert.equal(retry.versao,note.versao);
});

test('metadados e documentos podem ser completados sem duplicar resultados idênticos', async () => {
    let note = await reserved();
    note = await register(note,'autorizada',AUTHORIZED);
    const result = { protocolo: '123456',documentos: { danfe: '/arquivos/teste.pdf',xml: '/arquivos/teste.xml' } };
    note = await register(note,'autorizada',result);
    assert.equal(note.documentos.xml,'/arquivos/teste.xml');
    const count = (await events(note.id)).length;
    assert.deepEqual(await register(note,'autorizada',result),note);
    assert.equal((await events(note.id)).length,count);
});

test('cancelada permite completar XML/protocolo preservando identificação, snapshot e estado terminal', async () => {
    let note = await reserved();
    note = await register(note,'autorizada',AUTHORIZED);
    note = await register(note,'cancelada');
    const original = note;
    const result = { protocolo: '123456789',documentos: { xml_cancelamento: '/arquivos/cancelamento.xml' } };
    note = await register(note,'cancelada',result);
    assert.equal(note.status,'cancelada');
    assert.equal(note.protocolo,'123456789');
    assert.equal(note.documentos.xml_cancelamento,'/arquivos/cancelamento.xml');
    for (const field of ['chave','numero','serie','referencia','versao','ambiente']) assert.equal(note[field],original[field]);
    assert.deepEqual(note.snapshot,original.snapshot);
    assert.deepEqual(note.dados,original.dados);
    const count = (await events(note.id)).length;
    assert.deepEqual(await register(note,'cancelada',result),note);
    assert.equal((await events(note.id)).length,count);
    assert.deepEqual(await register(note,'processando'),note);
    for (const changed of [{ chave: '6'.repeat(44) },{ numero: '124' },{ serie: '2' }]) {
        await rejectsCode(register(note,'cancelada',changed),'22023');
    }
});

test('auditoria guarda hashes e metadados, sem payload, CPF ou erro livre, e é imutável', async () => {
    const note = await reserved();
    await register(note,'rejeitada',{ erro: 'Mensagem contendo dado pessoal que não deve entrar no evento' });
    const history = await events(note.id);
    const serialized = JSON.stringify(history);
    assert.equal(serialized.includes('98765432109'),false);
    assert.equal(serialized.includes('Cliente de teste'),false);
    assert.equal(serialized.includes('Mensagem contendo'),false);
    assert.match(history.find(e => e.evento === 'reservada').detalhes.snapshot_sha256,/^[a-f0-9]{64}$/);
    await rejectsCode(root(() => db.query("update public.jk_nf_eventos set evento='alterado' where nota_id=$1",[note.id])),'42501');
    await rejectsCode(root(() => db.query('delete from public.jk_nf_eventos where nota_id=$1',[note.id])),'42501');
});

test('resultado não aceita tokens, headers nem resposta bruta do provedor', async () => {
    const note = await reserved();
    for (const result of [{ token: 'segredo' },{ headers: {} },{ resposta_bruta: { cpf: '00000000000' } },{ documentos: { api_key: 'segredo' } },{ erro: { raw: 'objeto' } }]) {
        await rejectsCode(register(note,'rejeitada',result),'22023');
    }
    await rejectsCode(admin(() => rpc('jk_nf_registrar',[note.id,note.ambiente,note.referencia,'autorizada',AUTHORIZED,note.versao])),'42501');
});

test('constraints rejeitam autorização incompleta inclusive por SQL privilegiado', async () => {
    const note = await reserved();
    await rejectsCode(root(() => db.query("update public.jk_notas_fiscais set status='autorizada' where id=$1",[note.id])),'23514');
    await rejectsCode(root(() => db.query("update public.jk_notas_fiscais set status='autorizada',chave=$2,numero='1',serie=null where id=$1",[note.id,KEY])),'23514');
    await rejectsCode(service(() => db.query("update public.jk_notas_fiscais set status='autorizada' where id=$1",[note.id])),'42501');
});
