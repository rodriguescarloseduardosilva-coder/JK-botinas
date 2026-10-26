-- Pix imediato com confirmação bancária. Requer o banco de pedidos já existente:
-- public.jk_pedidos(id uuid, cliente_id uuid, total numeric, status text)
-- e public.jk_e_admin(). Não substitui nem recria esse banco.
-- A emissão da cobrança e a consulta ao BB ficam exclusivamente no servidor.

begin;

create table public.jk_pix_cobrancas (
    pedido_id uuid primary key references public.jk_pedidos(id) on delete restrict,
    subtotal_produtos numeric not null,
    frete numeric not null default 0,
    desconto numeric not null default 0,
    total numeric(8,2) not null,
    txid text not null unique,
    status text not null default 'pronta',
    pix_copia_cola text,
    expira_em timestamptz,
    end_to_end_id text unique,
    pago_em timestamptz,
    criado_em timestamptz not null default now(),
    atualizado_em timestamptz not null default now(),
    solicitado_em timestamptz,
    constraint jk_pix_valores_validos check (
        subtotal_produtos::text not in ('NaN', 'Infinity', '-Infinity')
        and frete::text not in ('NaN', 'Infinity', '-Infinity')
        and desconto::text not in ('NaN', 'Infinity', '-Infinity')
        and subtotal_produtos >= 0 and subtotal_produtos = trunc(subtotal_produtos, 2)
        and frete >= 0 and frete = trunc(frete, 2)
        and desconto >= 0 and desconto = trunc(desconto, 2)
        and total > 0 and total <= 999999.99
        and total = subtotal_produtos + frete - desconto
    ),
    constraint jk_pix_txid_estavel check (txid = 'jk' || replace(pedido_id::text, '-', '')),
    constraint jk_pix_status_valido check (status in ('pronta', 'solicitando', 'ativa', 'paga', 'expirada')),
    constraint jk_pix_codigo_valido check (pix_copia_cola is null or length(btrim(pix_copia_cola)) between 1 and 4096),
    constraint jk_pix_prazo_valido check (expira_em is null or isfinite(expira_em)),
    constraint jk_pix_cobranca_ativa check (status not in ('ativa', 'expirada') or (pix_copia_cola is not null and expira_em is not null)),
    constraint jk_pix_recibo_valido check (
        (status = 'paga' and end_to_end_id is not null and end_to_end_id ~ '^[A-Za-z0-9]{32}$' and pago_em is not null and isfinite(pago_em))
        or (status <> 'paga' and end_to_end_id is null and pago_em is null)
    )
);

alter table public.jk_pix_cobrancas enable row level security;

-- A chave publicável nunca recebe permissão para criar/editar cobranças ou recibos.
revoke all on public.jk_pix_cobrancas from public, anon, authenticated, service_role;
grant select on public.jk_pix_cobrancas to authenticated, service_role;

create policy jk_pix_leitura_dono_ou_admin on public.jk_pix_cobrancas
    for select to authenticated
    using (
        public.jk_e_admin()
        or exists (
            select 1 from public.jk_pedidos p
            where p.id = jk_pix_cobrancas.pedido_id and p.cliente_id = auth.uid()
        )
    );

create or replace function public.jk_pix_preparar(p_pedido_id uuid, p_frete numeric, p_desconto numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_pedido public.jk_pedidos%rowtype;
    v_cobranca public.jk_pix_cobrancas%rowtype;
    v_total numeric;
begin
    if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null or not coalesce(public.jk_e_admin(), false) then
        raise exception 'Acesso administrativo necessário.' using errcode = '42501';
    end if;
    if p_frete is null or p_desconto is null
        or p_frete::text in ('NaN', 'Infinity', '-Infinity') or p_desconto::text in ('NaN', 'Infinity', '-Infinity')
        or p_frete < 0 or p_desconto < 0 or p_frete <> trunc(p_frete, 2) or p_desconto <> trunc(p_desconto, 2) then
        raise exception 'Frete e desconto devem ser valores não negativos com até duas casas decimais.' using errcode = '22023';
    end if;

    -- Todas as funções bloqueiam pedido antes da cobrança, incluindo o gatilho.
    select * into v_pedido from public.jk_pedidos where id = p_pedido_id for update;
    if not found then raise exception 'Pedido indisponível.' using errcode = 'P0002'; end if;
    if v_pedido.status is distinct from 'aguardando_confirmacao' then
        raise exception 'O pedido não está aguardando confirmação.' using errcode = '22023';
    end if;
    if v_pedido.total is null or v_pedido.total::text in ('NaN', 'Infinity', '-Infinity')
        or v_pedido.total < 0 or v_pedido.total <> trunc(v_pedido.total, 2) then
        raise exception 'Subtotal do pedido inválido.' using errcode = '22023';
    end if;
    v_total := v_pedido.total + p_frete - p_desconto;
    if v_total <= 0 or v_total > 999999.99 then
        raise exception 'Total Pix deve estar entre R$ 0,01 e R$ 999.999,99.' using errcode = '22023';
    end if;

    select * into v_cobranca from public.jk_pix_cobrancas where pedido_id = p_pedido_id for update;
    if found then
        if v_cobranca.status <> 'pronta' then
            if v_cobranca.frete <> p_frete or v_cobranca.desconto <> p_desconto or v_cobranca.subtotal_produtos <> v_pedido.total then
                raise exception 'A cobrança já foi reservada; seus valores não podem ser alterados.' using errcode = '22023';
            end if;
            return to_jsonb(v_cobranca);
        end if;
        update public.jk_pix_cobrancas set subtotal_produtos = v_pedido.total,
            frete = p_frete, desconto = p_desconto, total = v_total, atualizado_em = clock_timestamp()
            where pedido_id = p_pedido_id returning * into v_cobranca;
    else
        insert into public.jk_pix_cobrancas(pedido_id, subtotal_produtos, frete, desconto, total, txid)
            values(p_pedido_id, v_pedido.total, p_frete, p_desconto, v_total, 'jk' || replace(p_pedido_id::text, '-', ''))
            returning * into v_cobranca;
    end if;
    return to_jsonb(v_cobranca);
end;
$$;

create or replace function public.jk_pix_obter(p_pedido_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resultado jsonb;
begin
    if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then
        raise exception 'Autenticação necessária.' using errcode = '42501';
    end if;
    -- O mesmo resultado nulo representa inexistência, ausência de cobrança e outro dono.
    select to_jsonb(c) into v_resultado from public.jk_pix_cobrancas c
        join public.jk_pedidos p on p.id = c.pedido_id
        where c.pedido_id = p_pedido_id
        and (p.cliente_id = auth.uid() or coalesce(public.jk_e_admin(), false));
    return v_resultado;
end;
$$;

create or replace function public.jk_pix_reservar(p_pedido_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cobranca public.jk_pix_cobrancas%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Operação exclusiva do servidor.' using errcode = '42501';
    end if;
    perform 1 from public.jk_pedidos where id = p_pedido_id for update;
    select * into v_cobranca from public.jk_pix_cobrancas where pedido_id = p_pedido_id for update;
    if not found then raise exception 'Cobrança não preparada.' using errcode = 'P0002'; end if;
    if v_cobranca.status = 'pronta' then
        update public.jk_pix_cobrancas set status = 'solicitando', solicitado_em = clock_timestamp(), atualizado_em = clock_timestamp()
            where pedido_id = p_pedido_id returning * into v_cobranca;
    end if;
    -- Retry não cria outro txid nem reabre cobrança paga/expirada.
    return to_jsonb(v_cobranca);
end;
$$;

create or replace function public.jk_pix_salvar_cobranca(p_pedido_id uuid, p_txid text, p_codigo text, p_expira_em timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cobranca public.jk_pix_cobrancas%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Operação exclusiva do servidor.' using errcode = '42501';
    end if;
    if p_codigo is null or length(btrim(p_codigo)) not between 1 and 4096 or p_expira_em is null or not isfinite(p_expira_em) then
        raise exception 'Código Pix ou vencimento inválido.' using errcode = '22023';
    end if;
    perform 1 from public.jk_pedidos where id = p_pedido_id for update;
    select * into v_cobranca from public.jk_pix_cobrancas where pedido_id = p_pedido_id for update;
    if not found then raise exception 'Cobrança não preparada.' using errcode = 'P0002'; end if;
    if p_txid is distinct from v_cobranca.txid then raise exception 'Txid divergente.' using errcode = '22023'; end if;
    if v_cobranca.status in ('paga', 'expirada') then return to_jsonb(v_cobranca); end if;
    if v_cobranca.status = 'ativa' then
        if v_cobranca.pix_copia_cola is distinct from p_codigo or v_cobranca.expira_em is distinct from p_expira_em then
            raise exception 'Os dados da cobrança ativa são imutáveis.' using errcode = '22023';
        end if;
        return to_jsonb(v_cobranca);
    end if;
    if v_cobranca.status <> 'solicitando' then raise exception 'Reserve a cobrança antes de salvar.' using errcode = '22023'; end if;
    update public.jk_pix_cobrancas set pix_copia_cola = p_codigo, expira_em = p_expira_em,
        status = case when p_expira_em <= clock_timestamp() then 'expirada' else 'ativa' end,
        atualizado_em = clock_timestamp() where pedido_id = p_pedido_id returning * into v_cobranca;
    return to_jsonb(v_cobranca);
end;
$$;

create or replace function public.jk_pix_confirmar(p_pedido_id uuid, p_txid text, p_valor numeric, p_end_to_end text, p_pago_em timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cobranca public.jk_pix_cobrancas%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Operação exclusiva do servidor.' using errcode = '42501';
    end if;
    if p_end_to_end is null or p_end_to_end !~ '^[A-Za-z0-9]{32}$' or p_pago_em is null or not isfinite(p_pago_em)
        or p_valor is null or p_valor::text in ('NaN', 'Infinity', '-Infinity') or p_valor <> trunc(p_valor, 2) then
        raise exception 'Recibo Pix inválido.' using errcode = '22023';
    end if;
    perform 1 from public.jk_pedidos where id = p_pedido_id for update;
    select * into v_cobranca from public.jk_pix_cobrancas where pedido_id = p_pedido_id for update;
    if not found then raise exception 'Cobrança não preparada.' using errcode = 'P0002'; end if;
    if p_txid is distinct from v_cobranca.txid or p_valor is distinct from v_cobranca.total then
        raise exception 'Txid ou valor recebido divergente.' using errcode = '22023';
    end if;
    if v_cobranca.status = 'paga' then
        if p_end_to_end is distinct from v_cobranca.end_to_end_id then raise exception 'Outro recibo já foi registrado.' using errcode = '22023'; end if;
        return to_jsonb(v_cobranca);
    end if;
    if v_cobranca.status not in ('solicitando', 'ativa', 'expirada') then
        raise exception 'Cobrança ainda não reservada.' using errcode = '22023';
    end if;
    -- Uma confirmação real do banco pode chegar após expiração ou antes de salvar o QR.
    -- O índice UNIQUE de end_to_end_id impede reutilizar o mesmo recibo em outro pedido.
    update public.jk_pix_cobrancas set status = 'paga', end_to_end_id = p_end_to_end, pago_em = p_pago_em,
        atualizado_em = clock_timestamp() where pedido_id = p_pedido_id returning * into v_cobranca;
    return to_jsonb(v_cobranca);
end;
$$;

create or replace function public.jk_pix_expirar(p_pedido_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cobranca public.jk_pix_cobrancas%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Operação exclusiva do servidor.' using errcode = '42501';
    end if;
    perform 1 from public.jk_pedidos where id = p_pedido_id for update;
    select * into v_cobranca from public.jk_pix_cobrancas where pedido_id = p_pedido_id for update;
    if not found then raise exception 'Cobrança não preparada.' using errcode = 'P0002'; end if;
    if v_cobranca.status in ('paga', 'expirada') then return to_jsonb(v_cobranca); end if;
    if v_cobranca.status <> 'ativa' or v_cobranca.expira_em is null or v_cobranca.expira_em > clock_timestamp() then
        raise exception 'A cobrança ainda não expirou.' using errcode = '22023';
    end if;
    update public.jk_pix_cobrancas set status = 'expirada', atualizado_em = clock_timestamp()
        where pedido_id = p_pedido_id returning * into v_cobranca;
    return to_jsonb(v_cobranca);
end;
$$;

create or replace function public.jk_pix_exigir_pagamento()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
    if new.status = 'confirmado' and old.status is distinct from 'confirmado' then
        select status into v_status from public.jk_pix_cobrancas where pedido_id = new.id for update;
        if v_status is distinct from 'paga' then
            raise exception 'A confirmação da venda exige pagamento Pix comprovado pelo banco.' using errcode = '23514';
        end if;
    end if;
    return new;
end;
$$;

create trigger jk_pix_confirmacao_exige_pagamento
    before update of status on public.jk_pedidos
    for each row execute function public.jk_pix_exigir_pagamento();

revoke all on function public.jk_pix_preparar(uuid,numeric,numeric) from public, anon, authenticated, service_role;
revoke all on function public.jk_pix_obter(uuid) from public, anon, authenticated, service_role;
revoke all on function public.jk_pix_reservar(uuid) from public, anon, authenticated, service_role;
revoke all on function public.jk_pix_salvar_cobranca(uuid,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.jk_pix_confirmar(uuid,text,numeric,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.jk_pix_expirar(uuid) from public, anon, authenticated, service_role;
revoke all on function public.jk_pix_exigir_pagamento() from public, anon, authenticated, service_role;
grant execute on function public.jk_pix_preparar(uuid,numeric,numeric), public.jk_pix_obter(uuid) to authenticated;
grant execute on function public.jk_pix_reservar(uuid), public.jk_pix_salvar_cobranca(uuid,text,text,timestamptz),
    public.jk_pix_confirmar(uuid,text,numeric,text,timestamptz), public.jk_pix_expirar(uuid) to service_role;

commit;
