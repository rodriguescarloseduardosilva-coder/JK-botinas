-- Módulo fiscal independente: não lê nem altera pedidos, pagamentos ou estoque.
-- Tokens e certificados pertencem ao servidor/provedor; nunca ao cadastro fiscal.
begin;

create function public.jk_nf_e_admin()
returns boolean language sql stable set search_path = '' as $$
    select coalesce(auth.role() = 'authenticated' and auth.uid() is not null
        and auth.jwt()->'app_metadata'->'loja_admin' = 'true'::jsonb, false);
$$;

-- Validação recursiva de nomes de credenciais conhecidos, sem bloquear a legítima
-- "chave" de acesso da NF-e. Não substitui a separação de segredos no servidor.
create function public.jk_nf_sem_segredos(p_valor jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_chave text; v_valor jsonb;
begin
    if p_valor is null then return true; end if;
    if jsonb_typeof(p_valor) = 'object' then
        for v_chave, v_valor in select key,value from jsonb_each(p_valor) loop
            if lower(replace(v_chave, '-', '_')) = any(array[
                'token','access_token','refresh_token','api_key','apikey','api_token',
                'authorization','headers','request_headers','client_secret','service_role',
                'service_role_key','supabase_service_role_key','password','senha','private_key',
                'key_pem','cert_pem','certificate','certificado','certificado_base64',
                'certificate_password','senha_certificado','pfx','focus_token','focusnfe_token',
                'focus_nfe_token','token_producao','token_homologacao'
            ]) or not public.jk_nf_sem_segredos(v_valor) then return false; end if;
        end loop;
    elsif jsonb_typeof(p_valor) = 'array' then
        for v_valor in select value from jsonb_array_elements(p_valor) loop
            if not public.jk_nf_sem_segredos(v_valor) then return false; end if;
        end loop;
    elsif jsonb_typeof(p_valor) = 'string' and (p_valor #>> '{}') ~ '-----BEGIN (CERTIFICATE|[A-Z ]*PRIVATE KEY)-----' then
        return false;
    end if;
    return true;
end;
$$;

create table public.jk_nf_config (
    id boolean primary key default true check (id),
    dados jsonb not null check (jsonb_typeof(dados) = 'object' and public.jk_nf_sem_segredos(dados)),
    versao integer not null default 1 check (versao > 0),
    atualizado_em timestamptz not null default now()
);

create table public.jk_notas_fiscais (
    id uuid primary key,
    referencia text generated always as ('jk' || replace(id::text, '-', '')) stored unique,
    origem text not null check (origem in ('site','loja','whatsapp')),
    pedido_origem text check (pedido_origem is null or length(btrim(pedido_origem)) between 1 and 150),
    dados jsonb not null check (jsonb_typeof(dados) = 'object' and public.jk_nf_sem_segredos(dados)),
    snapshot jsonb check (snapshot is null or (jsonb_typeof(snapshot) = 'object' and public.jk_nf_sem_segredos(snapshot))),
    ambiente text check (ambiente in ('homologacao','producao')),
    status text not null default 'rascunho' check (status in ('rascunho','enviando','processando','autorizada','rejeitada','cancelada')),
    versao integer not null default 1 check (versao > 0),
    numero text,
    serie text,
    chave text,
    protocolo text,
    erro text,
    documentos jsonb check (documentos is null or (jsonb_typeof(documentos) = 'object' and public.jk_nf_sem_segredos(documentos))),
    criado_em timestamptz not null default now(),
    atualizado_em timestamptz not null default now(),
    constraint jk_nf_snapshot_obrigatorio check (status = 'rascunho' or (snapshot is not null and ambiente is not null)),
    constraint jk_nf_autorizacao_completa check (status not in ('autorizada','cancelada') or (
        chave is not null and chave ~ '^[0-9]{44}$' and numero is not null and numero ~ '^[0-9]{1,9}$'
        and case when numero ~ '^[0-9]{1,9}$' then numero::numeric > 0 else false end
        and serie is not null and serie ~ '^[0-9]{1,3}$'
    ))
);

create table public.jk_nf_eventos (
    id bigint generated always as identity primary key,
    nota_id uuid references public.jk_notas_fiscais(id) on delete restrict,
    evento text not null,
    status_anterior text,
    status_novo text,
    versao integer,
    ambiente text,
    usuario_id uuid,
    detalhes jsonb not null default '{}'::jsonb check (jsonb_typeof(detalhes) = 'object' and public.jk_nf_sem_segredos(detalhes)),
    criado_em timestamptz not null default now()
);
create index jk_nf_eventos_nota on public.jk_nf_eventos(nota_id,id);

alter table public.jk_nf_config enable row level security;
alter table public.jk_notas_fiscais enable row level security;
alter table public.jk_nf_eventos enable row level security;
revoke all on public.jk_nf_config,public.jk_notas_fiscais,public.jk_nf_eventos from public,anon,authenticated,service_role;
grant select on public.jk_nf_config,public.jk_notas_fiscais,public.jk_nf_eventos to authenticated,service_role;
revoke all on sequence public.jk_nf_eventos_id_seq from public,anon,authenticated,service_role;
create policy jk_nf_config_admin on public.jk_nf_config for select to authenticated using (public.jk_nf_e_admin());
create policy jk_nf_notas_admin on public.jk_notas_fiscais for select to authenticated using (public.jk_nf_e_admin());
create policy jk_nf_eventos_admin on public.jk_nf_eventos for select to authenticated using (public.jk_nf_e_admin());

create function public.jk_nf_eventos_imutaveis()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'O histórico fiscal é imutável.' using errcode = '42501'; end;
$$;
create trigger jk_nf_eventos_imutaveis before update or delete on public.jk_nf_eventos
    for each row execute function public.jk_nf_eventos_imutaveis();

create function public.jk_nf_salvar_config(p_dados jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_config public.jk_nf_config%rowtype;
begin
    if not public.jk_nf_e_admin() then raise exception 'Acesso administrativo necessário.' using errcode = '42501'; end if;
    if p_dados is null or jsonb_typeof(p_dados) <> 'object' or not public.jk_nf_sem_segredos(p_dados) or octet_length(p_dados::text) > 524288 then
        raise exception 'Configuração fiscal inválida ou contém credenciais.' using errcode = '22023';
    end if;
    insert into public.jk_nf_config(id,dados) values(true,p_dados)
        on conflict(id) do update set dados=excluded.dados,versao=jk_nf_config.versao+1,atualizado_em=clock_timestamp() returning * into v_config;
    insert into public.jk_nf_eventos(evento,usuario_id,detalhes)
        values('config_salva',auth.uid(),jsonb_build_object('versao_config',v_config.versao,
            'config_sha256',encode(sha256(convert_to(p_dados::text,'UTF8')),'hex')));
    return to_jsonb(v_config);
end;
$$;

create function public.jk_nf_salvar_rascunho(p_id uuid,p_origem text,p_pedido_origem text,p_dados jsonb,p_versao integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_nota public.jk_notas_fiscais%rowtype; v_anterior text; v_evento text;
begin
    if not public.jk_nf_e_admin() then raise exception 'Acesso administrativo necessário.' using errcode = '42501'; end if;
    if p_id is null or p_versao is null or p_versao < 0 or p_origem is null or p_origem not in ('site','loja','whatsapp')
        or (p_pedido_origem is not null and length(btrim(p_pedido_origem)) not between 1 and 150)
        or p_dados is null or jsonb_typeof(p_dados) <> 'object' or not public.jk_nf_sem_segredos(p_dados) or octet_length(p_dados::text) > 524288 then
        raise exception 'Rascunho inválido ou contém credenciais.' using errcode = '22023';
    end if;
    select * into v_nota from public.jk_notas_fiscais where id=p_id for update;
    if not found then
        if p_versao <> 0 then raise exception 'Versão do rascunho divergente.' using errcode = '40001'; end if;
        insert into public.jk_notas_fiscais(id,origem,pedido_origem,dados) values(p_id,p_origem,p_pedido_origem,p_dados)
            on conflict(id) do nothing returning * into v_nota;
        if not found then raise exception 'O rascunho já foi criado por outra solicitação.' using errcode = '40001'; end if;
        v_evento := 'rascunho_criado';
    else
        if p_versao <> v_nota.versao then raise exception 'Versão do rascunho divergente.' using errcode = '40001'; end if;
        if v_nota.status not in ('rascunho','rejeitada') then raise exception 'Este documento não pode ser editado.' using errcode = '22023'; end if;
        v_anterior := v_nota.status;
        update public.jk_notas_fiscais set origem=p_origem,pedido_origem=p_pedido_origem,dados=p_dados,
            status='rascunho',versao=versao+1,erro=null,atualizado_em=clock_timestamp() where id=p_id returning * into v_nota;
        v_evento := 'rascunho_salvo';
    end if;
    insert into public.jk_nf_eventos(nota_id,evento,status_anterior,status_novo,versao,ambiente,usuario_id,detalhes)
        values(p_id,v_evento,v_anterior,v_nota.status,v_nota.versao,v_nota.ambiente,auth.uid(),
            jsonb_build_object('dados_sha256',encode(sha256(convert_to(p_dados::text,'UTF8')),'hex')));
    return to_jsonb(v_nota);
end;
$$;

create function public.jk_nf_reservar(p_id uuid,p_versao integer,p_payload jsonb,p_ambiente text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_nota public.jk_notas_fiscais%rowtype; v_anterior text; v_hash text; v_versao_anterior integer;
begin
    if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Operação exclusiva do servidor.' using errcode = '42501'; end if;
    if p_ambiente is null or p_ambiente not in ('homologacao','producao') then raise exception 'Ambiente inválido.' using errcode = '22023'; end if;
    select * into v_nota from public.jk_notas_fiscais where id=p_id for update;
    if not found then raise exception 'Nota fiscal indisponível.' using errcode = 'P0002'; end if;
    if v_nota.ambiente is not null and p_ambiente <> v_nota.ambiente then raise exception 'O ambiente da nota não pode ser alterado.' using errcode = '22023'; end if;
    if v_nota.status in ('enviando','processando','autorizada','cancelada') then
        return to_jsonb(v_nota) || jsonb_build_object('pode_enviar',false);
    end if;
    if p_versao is null or p_versao <> v_nota.versao then raise exception 'Versão do rascunho divergente.' using errcode = '40001'; end if;
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' or not public.jk_nf_sem_segredos(p_payload) or octet_length(p_payload::text) > 1048576 then
        raise exception 'Payload fiscal inválido ou contém credenciais.' using errcode = '22023';
    end if;
    v_anterior := v_nota.status; v_versao_anterior := v_nota.versao;
    v_hash := case when v_nota.snapshot is null then null else encode(sha256(convert_to(v_nota.snapshot::text,'UTF8')),'hex') end;
    update public.jk_notas_fiscais set snapshot=p_payload,ambiente=p_ambiente,status='enviando',versao=versao+1,
        numero=null,serie=null,chave=null,protocolo=null,erro=null,documentos=null,atualizado_em=clock_timestamp()
        where id=p_id returning * into v_nota;
    insert into public.jk_nf_eventos(nota_id,evento,status_anterior,status_novo,versao,ambiente,detalhes)
        values(p_id,'reservada',v_anterior,'enviando',v_nota.versao,v_nota.ambiente,
            jsonb_build_object('versao_anterior',v_versao_anterior,'snapshot_anterior_sha256',v_hash,
                'snapshot_sha256',encode(sha256(convert_to(p_payload::text,'UTF8')),'hex')));
    return to_jsonb(v_nota) || jsonb_build_object('pode_enviar',true);
end;
$$;

create function public.jk_nf_registrar(p_id uuid,p_ambiente text,p_referencia text,p_status text,p_resultado jsonb,p_versao integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_nota public.jk_notas_fiscais%rowtype; v_anterior text; v_chave text; v_numero text; v_serie text;
    v_campo text; v_valor jsonb; v_protocolo text; v_erro text; v_documentos jsonb;
begin
    if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Operação exclusiva do servidor.' using errcode = '42501'; end if;
    if p_status is null or p_status not in ('processando','autorizada','rejeitada','cancelada')
        or p_resultado is null or jsonb_typeof(p_resultado) <> 'object' or not public.jk_nf_sem_segredos(p_resultado) then
        raise exception 'Resultado fiscal inválido.' using errcode = '22023';
    end if;
    for v_campo,v_valor in select key,value from jsonb_each(p_resultado) loop
        if v_campo not in ('numero','serie','chave','protocolo','erro','documentos')
            or (v_campo = 'documentos' and jsonb_typeof(v_valor) not in ('object','null'))
            or (v_campo in ('numero','serie') and jsonb_typeof(v_valor) not in ('string','number','null'))
            or (v_campo in ('chave','protocolo','erro') and jsonb_typeof(v_valor) not in ('string','null')) then
            raise exception 'Campos inesperados no resultado fiscal.' using errcode = '22023';
        end if;
    end loop;
    if octet_length(p_resultado::text) > 131072 then raise exception 'Resultado fiscal muito grande.' using errcode = '22023'; end if;
    select * into v_nota from public.jk_notas_fiscais where id=p_id for update;
    if not found then raise exception 'Nota fiscal indisponível.' using errcode = 'P0002'; end if;
    if p_versao is null or p_versao <> v_nota.versao then raise exception 'Resultado pertence a outra tentativa.' using errcode = '40001'; end if;
    if p_ambiente is distinct from v_nota.ambiente or p_referencia is distinct from v_nota.referencia or v_nota.ambiente is null then
        raise exception 'Ambiente ou referência divergente.' using errcode = '22023';
    end if;
    if (v_nota.status = 'cancelada' and p_status <> 'cancelada')
        or (v_nota.status = 'autorizada' and p_status not in ('autorizada','cancelada')) then return to_jsonb(v_nota); end if;
    if v_nota.status = 'rascunho' then raise exception 'Reserve o documento antes de registrar resultado.' using errcode = '22023'; end if;
    if v_nota.status = 'rejeitada' then
        if p_status = 'rejeitada' then return to_jsonb(v_nota); end if;
        raise exception 'Uma nova tentativa exige nova reserva.' using errcode = '22023';
    end if;
    if p_status = 'cancelada' and v_nota.status not in ('autorizada','cancelada') then raise exception 'Somente nota autorizada pode ser cancelada.' using errcode = '22023'; end if;
    v_chave := coalesce(nullif(btrim(p_resultado->>'chave'),''),v_nota.chave);
    v_numero := coalesce(nullif(btrim(p_resultado->>'numero'),''),v_nota.numero);
    v_serie := coalesce(nullif(btrim(p_resultado->>'serie'),''),v_nota.serie);
    if p_status in ('autorizada','cancelada') and (v_chave is null or v_chave !~ '^[0-9]{44}$'
        or v_numero is null or v_numero !~ '^[0-9]{1,9}$' or v_serie is null or v_serie !~ '^[0-9]{1,3}$') then
        raise exception 'Autorização sem chave, número ou série válidos.' using errcode = '22023';
    end if;
    if p_status in ('autorizada','cancelada') and v_numero::numeric <= 0 then
        raise exception 'Número de autorização inválido.' using errcode = '22023';
    end if;
    if v_nota.status in ('autorizada','cancelada') and (v_chave is distinct from v_nota.chave or v_numero is distinct from v_nota.numero or v_serie is distinct from v_nota.serie) then
        raise exception 'A identificação da nota autorizada é imutável.' using errcode = '22023';
    end if;
    v_protocolo := coalesce(nullif(p_resultado->>'protocolo',''),v_nota.protocolo);
    v_erro := case when p_status='rejeitada' then coalesce(p_resultado->>'erro','Documento rejeitado pelo emissor.') else null end;
    v_documentos := case when p_resultado ? 'documentos' and p_resultado->'documentos' <> 'null'::jsonb
        then coalesce(v_nota.documentos,'{}'::jsonb) || p_resultado->'documentos' else v_nota.documentos end;
    if v_nota.status=p_status and v_nota.chave is not distinct from v_chave and v_nota.numero is not distinct from v_numero
        and v_nota.serie is not distinct from v_serie and v_nota.protocolo is not distinct from v_protocolo
        and v_nota.erro is not distinct from v_erro and v_nota.documentos is not distinct from v_documentos then return to_jsonb(v_nota); end if;
    v_anterior := v_nota.status;
    update public.jk_notas_fiscais set status=p_status,chave=v_chave,numero=v_numero,serie=v_serie,
        protocolo=v_protocolo,erro=v_erro,documentos=v_documentos,
        atualizado_em=clock_timestamp() where id=p_id returning * into v_nota;
    -- Apenas metadados fiscais: jamais payload, CPF/endereço, erro livre ou cabeçalhos.
    insert into public.jk_nf_eventos(nota_id,evento,status_anterior,status_novo,versao,ambiente,detalhes)
        values(p_id,'resultado',v_anterior,v_nota.status,v_nota.versao,v_nota.ambiente,
            jsonb_strip_nulls(jsonb_build_object('referencia',v_nota.referencia,'numero',v_nota.numero,
                'serie',v_nota.serie,'chave',v_nota.chave,'protocolo',v_nota.protocolo)));
    return to_jsonb(v_nota);
end;
$$;

revoke all on function public.jk_nf_e_admin(),public.jk_nf_sem_segredos(jsonb),public.jk_nf_eventos_imutaveis(),
    public.jk_nf_salvar_config(jsonb),public.jk_nf_salvar_rascunho(uuid,text,text,jsonb,integer),
    public.jk_nf_reservar(uuid,integer,jsonb,text),public.jk_nf_registrar(uuid,text,text,text,jsonb,integer)
    from public,anon,authenticated,service_role;
grant execute on function public.jk_nf_e_admin(),public.jk_nf_salvar_config(jsonb),
    public.jk_nf_salvar_rascunho(uuid,text,text,jsonb,integer) to authenticated;
grant execute on function public.jk_nf_reservar(uuid,integer,jsonb,text),
    public.jk_nf_registrar(uuid,text,text,text,jsonb,integer) to service_role;

commit;
