'use strict';

// Executa a migração real em PostgreSQL/WASM. Os stubs abaixo representam apenas
// o contrato mínimo do banco legado, que não está versionado neste repositório.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const ADMIN = '10000000-0000-4000-8000-000000000003';
const HISTORICAL = '20000000-0000-4000-8000-000000000000';
const RECEIPT = 'E' + '1'.repeat(31);
const FUTURE = '2099-01-01T00:00:00Z';
const PAID_AT = '2026-10-26T12:00:00Z';
let db;
let nextOrder = 1;

async function identity(role, owner, admin, action, jwtRole = role) {
    assert.ok(['postgres', 'authenticated', 'anon', 'service_role'].includes(role));
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.role', $1, false), set_config('request.jwt.claim.sub', $2, false), set_config('request.jwt.claim.admin', $3, false)", [jwtRole, owner || '', admin ? 'true' : 'false']);
    await db.exec('set role ' + role);
    try { return await action(); }
    finally { await db.exec('reset role'); }
}
const admin = action => identity('authenticated', ADMIN, true, action);
const server = action => identity('service_role', null, false, action);
const owner = action => identity('authenticated', OWNER, false, action);
const root = action => identity('postgres', null, false, action);
async function rpc(name, args) {
    assert.match(name, /^jk_pix_[a-z_]+$/);
    const result = await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as result`, args);
    return result.rows[0].result;
}
async function seed(total = '100.00', status = 'aguardando_confirmacao', customer = OWNER) {
    const id = '20000000-0000-4000-8000-' + String(nextOrder++).padStart(12, '0');
    await root(() => db.query('insert into public.jk_pedidos(id,cliente_id,total,status) values ($1,$2,$3,$4)', [id, customer, total, status]));
    return id;
}
const prepare = (id, freight = '0', discount = '0') => admin(() => rpc('jk_pix_preparar', [id, freight, discount]));
const reserve = id => server(() => rpc('jk_pix_reservar', [id]));
const save = (id, txid, code = '000201-PIX-TESTE', expires = FUTURE) => server(() => rpc('jk_pix_salvar_cobranca', [id, txid, code, expires]));
const confirm = (id, txid, amount = '100', receipt = RECEIPT, time = PAID_AT) => server(() => rpc('jk_pix_confirmar', [id, txid, amount, receipt, time]));
async function ready(total = '100') { const id = await seed(total); const charge = await prepare(id); return { id, charge }; }
async function active(total = '100') { const { id, charge } = await ready(total); await reserve(id); return { id, charge: await save(id, charge.txid) }; }
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

before(async () => {
    db = new PGlite();
    await db.exec(`
        create role anon noinherit;
        create role authenticated noinherit;
        create role service_role noinherit bypassrls;
        create schema auth;
        grant usage on schema public,auth to anon,authenticated,service_role;
        create function auth.uid() returns uuid language sql stable as
            $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create function auth.role() returns text language sql stable as
            $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
        create function public.jk_e_admin() returns boolean language sql stable as
            $$ select coalesce(current_setting('request.jwt.claim.admin', true), '') = 'true' $$;
        create table public.jk_pedidos(id uuid primary key,cliente_id uuid,total numeric,status text);
        alter table public.jk_pedidos enable row level security;
        grant select on public.jk_pedidos to authenticated;
        create policy pedido_dono_ou_admin on public.jk_pedidos for select to authenticated
            using(cliente_id = auth.uid() or public.jk_e_admin());
        insert into public.jk_pedidos values('${HISTORICAL}','${OWNER}',100,'confirmado');
    `);
    await db.exec(readFileSync(join(__dirname, '../supabase/migrations/20261026_pix.sql'), 'utf8'));
});
after(async () => { if (db) await db.close(); });

test('ACL permite só leitura aos clientes e execução de RPCs apropriadas', async () => {
    const { rows: [acl] } = await db.query(`select
        has_table_privilege('authenticated','public.jk_pix_cobrancas','SELECT') as leitura,
        has_table_privilege('authenticated','public.jk_pix_cobrancas','INSERT,UPDATE,DELETE') as escrita,
        has_table_privilege('service_role','public.jk_pix_cobrancas','UPDATE') as escrita_servidor,
        has_table_privilege('anon','public.jk_pix_cobrancas','SELECT') as anonimo,
        has_function_privilege('authenticated','public.jk_pix_preparar(uuid,numeric,numeric)','EXECUTE') as preparar,
        has_function_privilege('authenticated','public.jk_pix_confirmar(uuid,text,numeric,text,timestamptz)','EXECUTE') as confirmar_cliente,
        has_function_privilege('service_role','public.jk_pix_confirmar(uuid,text,numeric,text,timestamptz)','EXECUTE') as confirmar_servidor,
        has_function_privilege('anon','public.jk_pix_obter(uuid)','EXECUTE') as obter_anonimo`);
    assert.deepEqual(acl, { leitura: true, escrita: false, escrita_servidor: false, anonimo: false, preparar: true, confirmar_cliente: false, confirmar_servidor: true, obter_anonimo: false });
});

test('preparação calcula total no banco, captura subtotal e atribui txid determinístico', async () => {
    const id = await seed('150.45');
    const c = await prepare(id, '12.35', '5.10');
    assert.equal(c.subtotal_produtos, 150.45);
    assert.equal(c.total, 157.70);
    assert.equal(c.frete, 12.35);
    assert.equal(c.desconto, 5.10);
    assert.equal(c.status, 'pronta');
    assert.equal(c.txid, 'jk' + id.replaceAll('-', ''));
    assert.match(c.txid, /^[A-Za-z0-9]{34}$/);
    assert.equal(c.end_to_end_id, null);
});

test('preparar requer administrador autenticado e pedido aguardando confirmação', async () => {
    const id = await seed();
    await rejectsCode(owner(() => rpc('jk_pix_preparar', [id, 0, 0])), '42501');
    await rejectsCode(identity('anon', OWNER, true, () => rpc('jk_pix_preparar', [id, 0, 0])), '42501');
    await rejectsCode(server(() => rpc('jk_pix_preparar', [id, 0, 0])), '42501');
    await rejectsCode(prepare(await seed('100', 'confirmado')), '22023');
    await rejectsCode(prepare('20000000-0000-4000-8000-999999999999'), 'P0002');
});

test('validação rejeita negativos, frações de centavo, não finitos e totais fora do limite', async () => {
    const id = await seed();
    for (const [freight, discount] of [[null,0], [0,null], [-1,0], [0,-1], ['0.001',0], [0,'0.001'], ['NaN',0], [0,'Infinity'], ['-Infinity',0], [0,100], [0,101], [999999.99,0]]) {
        await rejectsCode(prepare(id, freight, discount), '22023');
    }
    assert.equal((await prepare(id, 0, '99.99')).total, 0.01);
    assert.equal((await prepare(id, '999899.99', 0)).total, 999999.99);
    for (const badSubtotal of [null, '-1', '0.001', 'NaN', 'Infinity']) {
        await rejectsCode(prepare(await seed(badSubtotal)), '22023');
    }
});

test('reserva é idempotente e impede alterar valores já enviados ao banco', async () => {
    const { id } = await ready();
    assert.equal((await prepare(id, 10, 5)).total, 105);
    const reserved = await reserve(id);
    assert.equal(reserved.status, 'solicitando');
    const again = await reserve(id);
    assert.deepEqual(again, reserved);
    assert.equal((await prepare(id, 10, 5)).txid, reserved.txid);
    await rejectsCode(prepare(id, 11, 5), '22023');
    await root(() => db.query('update public.jk_pedidos set total = 101 where id = $1', [id]));
    await rejectsCode(prepare(id, 10, 5), '22023');
});

test('RLS e obter isolam cliente, administrador e pedido sem cobrança', async () => {
    const { id } = await ready();
    const otherId = await seed('100', 'aguardando_confirmacao', OTHER);
    await prepare(otherId);
    const emptyId = await seed();
    assert.equal((await owner(() => rpc('jk_pix_obter', [id]))).pedido_id, id);
    assert.equal(await owner(() => rpc('jk_pix_obter', [otherId])), null);
    assert.equal(await owner(() => rpc('jk_pix_obter', [emptyId])), null);
    assert.equal(await owner(() => rpc('jk_pix_obter', ['20000000-0000-4000-8000-999999999999'])), null);
    const ownRows = await owner(() => db.query('select pedido_id from public.jk_pix_cobrancas where pedido_id in ($1,$2)', [id, otherId]));
    assert.deepEqual(ownRows.rows, [{ pedido_id: id }]);
    assert.equal((await admin(() => rpc('jk_pix_obter', [otherId]))).pedido_id, otherId);
    await rejectsCode(identity('anon', null, false, () => rpc('jk_pix_obter', [id])), '42501');
    await rejectsCode(owner(() => db.query("update public.jk_pix_cobrancas set status='paga' where pedido_id=$1", [id])), '42501');
});

test('RPCs de banco não aceitam clientes, mesmo com privilégio SQL acidental', async () => {
    const { id, charge } = await ready();
    const calls = [
        ['jk_pix_reservar', [id]],
        ['jk_pix_salvar_cobranca', [id, charge.txid, 'codigo', FUTURE]],
        ['jk_pix_confirmar', [id, charge.txid, 100, RECEIPT, PAID_AT]],
        ['jk_pix_expirar', [id]]
    ];
    for (const [fn, args] of calls) {
        await rejectsCode(admin(() => rpc(fn, args)), '42501');
        // Superusuário tem EXECUTE, mas o JWT sem service_role ainda é recusado.
        await rejectsCode(identity('postgres', ADMIN, true, () => rpc(fn, args), 'authenticated'), '42501');
    }
});

test('salvar exige reserva, txid correto e QR válido, sem substituir cobrança ativa', async () => {
    const { id, charge } = await ready();
    await rejectsCode(save(id, charge.txid), '22023');
    await reserve(id);
    await rejectsCode(save(id, 'jk' + '0'.repeat(32)), '22023');
    await rejectsCode(save(id, charge.txid, ''), '22023');
    await rejectsCode(save(id, charge.txid, 'codigo', null), '22023');
    await rejectsCode(save(id, charge.txid, 'codigo', 'infinity'), '22023');
    const saved = await save(id, charge.txid);
    assert.equal(saved.status, 'ativa');
    assert.deepEqual(await save(id, charge.txid), saved);
    await rejectsCode(save(id, charge.txid, 'outro-codigo'), '22023');
});

test('confirmação valida txid, centavos, valor integral e recibo antes de registrar pagamento', async () => {
    const { id, charge } = await active();
    for (const args of [[id,'outro',100,RECEIPT,PAID_AT], [id,charge.txid,'99.99',RECEIPT,PAID_AT], [id,charge.txid,'100.001',RECEIPT,PAID_AT], [id,charge.txid,'NaN',RECEIPT,PAID_AT], [id,charge.txid,100,'invalido',PAID_AT], [id,charge.txid,100,RECEIPT,null]]) {
        await rejectsCode(server(() => rpc('jk_pix_confirmar', args)), '22023');
    }
    assert.equal((await owner(() => rpc('jk_pix_obter', [id]))).status, 'ativa');
    const paid = await confirm(id, charge.txid);
    assert.equal(paid.status, 'paga');
    assert.equal(paid.end_to_end_id, RECEIPT);
    assert.deepEqual(await confirm(id, charge.txid, '100', RECEIPT, '2026-10-26T13:00:00Z'), paid);
    await rejectsCode(confirm(id, charge.txid, '100', 'E' + '2'.repeat(31)), '22023');
    assert.equal((await root(() => db.query('select status from public.jk_pedidos where id=$1', [id]))).rows[0].status, 'aguardando_confirmacao');
});

test('recibo bancário não pode pagar dois pedidos', async () => {
    const original = await active();
    const receipt = 'E' + '7'.repeat(31);
    await confirm(original.id, original.charge.txid, 100, receipt);
    const { id, charge } = await active();
    await rejectsCode(confirm(id, charge.txid, 100, receipt), '23505');
    assert.equal((await owner(() => rpc('jk_pix_obter', [id]))).status, 'ativa');
    assert.equal((await confirm(id, charge.txid, 100, 'E' + '3'.repeat(31))).status, 'paga');
});

test('pagamento pode chegar antes do QR, porém nunca antes da reserva', async () => {
    const { id, charge } = await ready();
    const receipt = 'E' + '4'.repeat(31);
    await rejectsCode(confirm(id, charge.txid, 100, receipt), '22023');
    await reserve(id);
    const paid = await confirm(id, charge.txid, 100, receipt);
    assert.equal(paid.pix_copia_cola, null);
    assert.deepEqual(await save(id, charge.txid), paid);
    assert.deepEqual(await reserve(id), paid);
    assert.deepEqual(await server(() => rpc('jk_pix_expirar', [id])), paid);
});

test('expiração exige prazo transcorrido e confirmação tardia permanece monotônica', async () => {
    const { id, charge } = await active();
    await rejectsCode(server(() => rpc('jk_pix_expirar', [id])), '22023');
    await root(() => db.query("update public.jk_pix_cobrancas set expira_em=now()-interval '1 second' where pedido_id=$1", [id]));
    assert.equal((await server(() => rpc('jk_pix_expirar', [id]))).status, 'expirada');
    const paid = await confirm(id, charge.txid, 100, 'E' + '5'.repeat(31));
    assert.equal(paid.status, 'paga');
    assert.deepEqual(await server(() => rpc('jk_pix_expirar', [id])), paid);
});

test('recuperação de cobrança com prazo passado já retorna expirada', async () => {
    const { id, charge } = await ready();
    await reserve(id);
    assert.equal((await save(id, charge.txid, 'pix-recuperado', '2020-01-01T00:00:00Z')).status, 'expirada');
});

test('gatilho bloqueia confirmação manual sem pagamento e preserva histórico confirmado', async () => {
    const id = await seed();
    const update = () => root(() => db.query("update public.jk_pedidos set status='confirmado' where id=$1", [id]));
    await rejectsCode(update(), '23514');
    const charge = await prepare(id);
    await reserve(id);
    await rejectsCode(update(), '23514');
    await confirm(id, charge.txid, 100, 'E' + '6'.repeat(31));
    await update();
    assert.equal((await root(() => db.query('select status from public.jk_pedidos where id=$1', [id]))).rows[0].status, 'confirmado');
    await root(() => db.query("update public.jk_pedidos set status='confirmado' where id=$1", [HISTORICAL]));
    assert.equal(await owner(() => rpc('jk_pix_obter', [HISTORICAL])), null);
});

test('constraints impedem recibo incompleto e valores inconsistentes mesmo com SQL privilegiado', async () => {
    const { id } = await ready();
    await rejectsCode(root(() => db.query("update public.jk_pix_cobrancas set status='paga',pago_em=now() where pedido_id=$1", [id])), '23514');
    await rejectsCode(root(() => db.query("update public.jk_pix_cobrancas set total=101 where pedido_id=$1", [id])), '23514');
    await rejectsCode(root(() => db.query("update public.jk_pix_cobrancas set txid='txid-errado' where pedido_id=$1", [id])), '23514');
});
