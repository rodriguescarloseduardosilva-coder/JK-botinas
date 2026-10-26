(function () {
    'use strict';
    const el = id => document.getElementById(id);
    const form = el('invoiceForm');
    const issuerForm = el('issuerForm');
    const states = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
    const labels = {rascunho:'Rascunho',enviando:'Envio em verificação',processando:'Em processamento',autorizada:'Autorizada',rejeitada:'Rejeitada',cancelada:'Cancelada'};
    const editable = note => !note || ['rascunho','rejeitada'].includes(note.status);
    const money = value => Number(value || 0).toLocaleString('pt-BR', {style:'currency',currency:'BRL'});
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const digits = value => String(value || '').replace(/\D/g,'');
    const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
    let currentUser = null, epoch = 0, authRevision = 0, config = null, current = null, profiles = [], extras = {}, reviewedEnvironment = null;
    let notes = new Map(), page = 0, historyRevision = 0, historyOrder = null, timer = null, pendingCancel = null, busy = false;
    let configDirty = false, pendingProfiles = null, pendingExtras = null;

    document.querySelectorAll('[data-states]').forEach(select => {
        select.innerHTML = '<option value="">Selecione</option>' + states.map(uf => `<option>${uf}</option>`).join('');
    });
    issuerForm.elements.uf.value = 'DF';
    issuerForm.elements.uf.innerHTML = '<option value="DF">DF</option>';
    issuerForm.elements.regime_tributario.value = '1';

    function message(text) { el('fiscalMessage').textContent = text; }
    function setBusy(value) {
        busy = value;
        Array.from(form.elements).forEach(input => { input.disabled = value || !editable(current); });
        el('sendInvoice').disabled = value;
    }
    function showView(name) {
        document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== 'view-' + name; });
        document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === name)));
        clearTimeout(timer);
        if (name === 'historico' && currentUser) loadHistory();
    }
    function profileOptions(selected) {
        return '<option value="">Selecione o perfil fiscal</option>' + profiles.map(profile => `<option value="${escape(profile.id)}" ${profile.id === selected ? 'selected' : ''}>${escape(profile.nome)}</option>`).join('');
    }
    function renderProfile(row) {
        const profile = profiles.find(p => p.id === row.querySelector('[name="perfil_id"]').value);
        const fields = profile?.campos_fiscais || {};
        row.querySelector('.item-fiscal').textContent = profile ? `NCM: ${fields.codigo_ncm || 'não informado'} · CFOP: ${fields.cfop || 'não informado'} · ICMS: ${fields.icms_situacao_tributaria || 'não informado'}` : 'Selecione o perfil desta operação.';
        if (fields.unidade_comercial) row.querySelector('[name="unidade"]').value = fields.unidade_comercial;
    }
    function addItem(item = {}) {
        if (busy || !editable(current)) return;
        const row = document.createElement('div');
        row.className = 'invoice-item';
        row.innerHTML = `<div class="item-heading"><h3>Produto</h3><button type="button" class="secondary" data-remove-item>Remover</button></div><div class="grid three">
            <label>Código / SKU<input name="codigo" maxlength="60" value="${escape(item.codigo)}" required></label>
            <label>Descrição<input name="descricao" maxlength="120" value="${escape(item.descricao)}" required></label>
            <label>Perfil fiscal<select name="perfil_id" required>${profileOptions(item.perfil_id)}</select></label>
            <label>Unidade<input name="unidade" maxlength="6" value="${escape(item.unidade)}" required></label>
            <label>Quantidade<input name="quantidade" type="number" min="0.0001" step="0.0001" value="${escape(item.quantidade ?? 1)}" required></label>
            <label>Preço unitário (R$)<input name="preco_unitario" type="number" min="0.0001" step="0.0001" value="${escape(item.preco_unitario)}" required></label>
        </div><p class="item-fiscal"></p>`;
        row.querySelector('[data-remove-item]').addEventListener('click', () => { if (!busy) { row.remove(); updateTotal(); } });
        row.querySelector('[name="perfil_id"]').addEventListener('change', () => renderProfile(row));
        row.addEventListener('input', updateTotal);
        el('invoiceItems').append(row);
        renderProfile(row); updateTotal();
    }
    function items() {
        return Array.from(el('invoiceItems').children).map(row => Object.fromEntries(['codigo','descricao','perfil_id','unidade','quantidade','preco_unitario'].map(key => [key, row.querySelector(`[name="${key}"]`).value.trim()])));
    }
    function displayedTotal() {
        return items().reduce((sum,item) => sum + Math.round(Number(item.quantidade) * Number(item.preco_unitario) * 100),0) / 100 + Number(form.elements.frete.value || 0) - Number(form.elements.desconto.value || 0);
    }
    function updateTotal() { el('invoiceTotal').textContent = money(displayedTotal()); }
    function paymentFields() {
        const card = ['03','04'].includes(form.elements.forma_pagamento.value);
        const integrated = card && form.elements.tipo_integracao.value === '1';
        const other = form.elements.forma_pagamento.value === '99';
        for (const [name,visible,required] of [['tipo_integracao',card,card],['cnpj_credenciadora',integrated,integrated],['numero_autorizacao',integrated,integrated],['bandeira_operadora',card,false],['descricao_pagamento',other,other]]) {
            const input = form.elements[name]; input.closest('label').hidden = !visible; input.required = required;
        }
    }
    function collect() {
        const f = form.elements;
        const destinatario = Object.fromEntries(['nome','documento','tipo_documento','inscricao_estadual','indicador_ie','logradouro','numero','bairro','municipio','codigo_municipio','uf','cep','email'].map(key => [key, f[key].value.trim()]));
        destinatario.documento = digits(destinatario.documento); destinatario.cep = digits(destinatario.cep);
        const pagamento = {forma:f.forma_pagamento.value, indicador_pagamento:f.indicador_pagamento.value};
        if (['03','04'].includes(pagamento.forma)) {
            pagamento.tipo_integracao = f.tipo_integracao.value;
            if (f.bandeira_operadora.value) pagamento.bandeira_operadora = f.bandeira_operadora.value;
            if (pagamento.tipo_integracao === '1') {
                pagamento.cnpj_credenciadora = digits(f.cnpj_credenciadora.value);
                pagamento.numero_autorizacao = f.numero_autorizacao.value.trim();
            }
        }
        if (pagamento.forma === '99') pagamento.descricao_pagamento = f.descricao_pagamento.value.trim();
        return {config_versao: config?.versao, destinatario, itens:items(), frete:f.frete.value, desconto:f.desconto.value, pagamento,
            natureza_operacao:f.natureza_operacao.value.trim(), presenca_comprador:Number(f.presenca_comprador.value), consumidor_final:Number(f.consumidor_final.value), campos_adicionais:{}};
    }
    function newNote() {
        if (busy) return;
        current = null; form.reset(); el('invoiceItems').replaceChildren();
        el('draftTitle').textContent = 'Nova nota fiscal'; el('draftState').textContent = 'Rascunho · Ainda não enviado à SEFAZ';
        el('originOrder').textContent = ''; setBusy(false); paymentFields(); addItem(); showView('nova');
    }
    function loadNote(note) {
        if (!editable(note)) { message('Esta nota já foi enviada. Consulte a situação e os documentos no histórico.'); return; }
        newNote(); current = note;
        const data = note.dados || {}, f = form.elements;
        f.origem.value = note.origem;
        for (const [key,value] of Object.entries(data.destinatario || {})) if (f[key]) f[key].value = value ?? '';
        for (const key of ['frete','desconto','natureza_operacao','presenca_comprador','consumidor_final']) if (data[key] !== undefined) f[key].value = data[key];
        f.forma_pagamento.value = data.pagamento?.forma || '';
        f.indicador_pagamento.value = data.pagamento?.indicador_pagamento ?? '';
        f.tipo_integracao.value = data.pagamento?.tipo_integracao ?? '';
        for (const key of ['cnpj_credenciadora','numero_autorizacao','bandeira_operadora','descricao_pagamento']) f[key].value = data.pagamento?.[key] ?? '';
        paymentFields();
        el('invoiceItems').replaceChildren(); (data.itens || []).forEach(addItem);
        el('draftTitle').textContent = 'Editar rascunho';
        el('draftState').textContent = `${labels[note.status]} · Versão ${note.versao}`;
        el('originOrder').textContent = note.pedido_origem ? 'Pedido de origem: ' + note.pedido_origem : '';
        updateTotal();
    }
    async function saveDraft() {
        if (busy || !currentUser || !editable(current)) return null;
        if (configDirty) { message('Salve ou descarte as alterações da configuração fiscal antes de revisar a nota.'); showView('configuracao'); return null; }
        if (!config || !profiles.length) { message('Complete a configuração fiscal antes de salvar a nota.'); showView('configuracao'); return null; }
        if (!form.reportValidity()) return null;
        if (!items().length || !Number.isFinite(displayedTotal()) || displayedTotal() <= 0) { message('Inclua ao menos um produto e confira o total da nota.'); return null; }
        const owner = epoch;
        const id = current?.id || crypto.randomUUID();
        const data = collect(), origem = form.elements.origem.value;
        const pedido = current?.pedido_origem || null;
        setBusy(true); message('Salvando rascunho…');
        try {
            const {data:note,error} = await supabaseClient.rpc('jk_nf_salvar_rascunho', {p_id:id,p_origem:origem,p_pedido_origem:pedido,p_dados:data,p_versao:current?.versao || 0});
            if (owner !== epoch) return null;
            if (error || !note?.id) throw new Error('Não foi possível salvar. Atualize o rascunho antes de repetir; ele pode ter sido alterado em outra tela.');
            current = note;
            el('draftState').textContent = `Rascunho salvo · Versão ${note.versao}`; message('Rascunho salvo. A nota ainda não foi enviada.');
            return note;
        } catch (error) { if (owner === epoch) message(error.message); return null; }
        finally { if (owner === epoch) setBusy(false); }
    }
    async function review() {
        const note = await saveDraft();
        if (!note) return;
        const owner = epoch;
        let preview;
        setBusy(true);
        try { preview = await api({acao:'prever',id:note.id}); }
        catch (error) { if (owner === epoch) message(error.message); return; }
        finally { if (owner === epoch) setBusy(false); }
        if (owner !== epoch) return;
        reviewedEnvironment = preview.ambiente;
        const data = note.dados;
        el('reviewSummary').textContent = `${data.destinatario.nome} · ${data.destinatario.tipo_documento.toUpperCase()}: ${data.destinatario.documento} · ${data.destinatario.municipio}/${data.destinatario.uf}`;
        el('reviewDetails').innerHTML = `<p>${escape(data.natureza_operacao)}</p><p class="notice">${preview.ambiente === 'homologacao' ? 'HOMOLOGAÇÃO — SEM VALOR FISCAL' : 'PRODUÇÃO — emissão de nota fiscal real'}</p>` + data.itens.map(item => `<div class="review-line">${escape(item.quantidade)} × ${escape(item.descricao)} · ${money(item.preco_unitario)}<br><small>Perfil: ${escape(profiles.find(profile => profile.id === item.perfil_id)?.nome || item.perfil_id)}</small></div>`).join('') + `<p><strong>Total fiscal conferido pelo servidor: ${money(preview.total)}</strong></p>`;
        el('reviewMessage').textContent = preview.habilitado ? '' : 'A conexão com o emissor ainda precisa ser ativada. O rascunho pode ser revisado e salvo.';
        el('reviewAccepted').checked = false; el('reviewDialog').showModal();
    }
    async function api(body, documentRequest = false) {
        const owner = epoch;
        const {data,error} = await supabaseClient.auth.getSession();
        if (owner !== epoch || !currentUser || error || !data.session?.access_token ||
            (data.session.user && data.session.user.id !== currentUser.id)) throw new Error('Entre novamente na sua conta.');
        const response = await fetch('/api/fiscal', {method:'POST',cache:'no-store',headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},body:JSON.stringify(body)});
        if (response.ok && documentRequest) return response.blob();
        let result;
        try { result = await response.json(); } catch { throw new Error('Não foi possível concluir a consulta ao emissor. Tente consultar a mesma nota novamente.'); }
        if (!response.ok) throw new Error(result.message || 'Não foi possível concluir a operação fiscal.');
        return result;
    }
    async function send() {
        if (configDirty) { el('reviewMessage').textContent = 'Salve ou descarte a configuração fiscal e revise a nota novamente.'; return; }
        if (busy || !current || !el('reviewAccepted').checked) { el('reviewMessage').textContent = 'Confirme a revisão dos dados antes de emitir.'; return; }
        const id = current.id, owner = epoch;
        setBusy(true); el('reviewMessage').textContent = 'Enviando solicitação. Aguarde a resposta do emissor…';
        try {
            const result = await api({acao:'emitir',id,versao:current.versao,ambiente:reviewedEnvironment});
            if (owner !== epoch) return;
            el('reviewDialog').close(); message(`Solicitação registrada: ${labels[result.status] || 'consulte o histórico'}.`);
            current = null; showView('historico');
        } catch (error) {
            if (owner === epoch) { el('reviewMessage').textContent = error.message + ' Consulte o histórico antes de iniciar outra nota.'; await loadHistory(false); }
        } finally { if (owner === epoch) setBusy(false); }
    }
    async function loadConfig() {
        const owner = epoch;
        const {data,error} = await supabaseClient.from('jk_nf_config').select('id,dados,versao').eq('id',true).maybeSingle();
        if (owner !== epoch) return;
        if (error) throw new Error('Não foi possível abrir a configuração fiscal. Confira a instalação do módulo no Supabase.');
        config = data; profiles = data?.dados?.perfis || []; extras = data?.dados?.campos_adicionais || {};
        pendingProfiles = null; pendingExtras = null; configDirty = false;
        issuerForm.reset(); issuerForm.elements.uf.value = 'DF'; issuerForm.elements.regime_tributario.value = '1';
        for (const [key,value] of Object.entries(data?.dados?.emitente || {})) if (issuerForm.elements[key]) issuerForm.elements[key].value = value;
        el('fiscalProfileReviewed').checked = Boolean(data?.dados?.revisado_contabilidade);
        el('profilesSummary').textContent = profiles.length ? `${profiles.length} perfil(is): ` + profiles.map(p => p.nome).join(', ') : 'Nenhum perfil importado.';
        el('missingProfiles').hidden = Boolean(profiles.length && config);
    }
    async function saveConfig(event) {
        event.preventDefault();
        if (!currentUser || !issuerForm.reportValidity()) return;
        const selectedProfiles = pendingProfiles || profiles, selectedExtras = pendingExtras || extras;
        if (!selectedProfiles.length) { message('Importe ao menos um perfil fiscal validado pela contabilidade.'); return; }
        const owner = epoch, button = issuerForm.querySelector('[type="submit"]'); button.disabled = true;
        const emitente = Object.fromEntries(new FormData(issuerForm));
        emitente.cnpj = digits(emitente.cnpj); emitente.cep = digits(emitente.cep); emitente.regime_tributario = Number(emitente.regime_tributario);
        try {
            const {data,error} = await supabaseClient.rpc('jk_nf_salvar_config', {p_dados:{emitente,perfis:selectedProfiles,campos_adicionais:selectedExtras,revisado_contabilidade:true}});
            if (owner !== epoch) return;
            if (error || !data?.dados) throw new Error('Não foi possível salvar a configuração. Confira os dados e os perfis importados.');
            await loadConfig(); if (owner !== epoch) return;
            message('Configuração salva. Revise os rascunhos antes de emitir com os novos perfis.');
            if (!current) newNote();
        } catch (error) { if (owner === epoch) message(error.message); }
        finally { if (owner === epoch) button.disabled = false; }
    }
    async function loadHistory(visible = true) {
        if (!currentUser) return;
        const owner = epoch, request = ++historyRevision;
        if (visible) el('invoiceHistory').textContent = 'Carregando notas…';
        let query = supabaseClient.from('jk_notas_fiscais').select('*',{count:'exact'}).order('criado_em',{ascending:false}).order('id',{ascending:false});
        if (historyOrder) query = query.eq('pedido_origem',historyOrder);
        el('historyTitle').textContent = historyOrder ? 'Notas do pedido de origem' : 'Histórico de notas';
        el('allInvoices').hidden = !historyOrder;
        if (el('invoiceFilter').value) query = query.eq('status',el('invoiceFilter').value);
        try {
            const {data,error,count} = await query.range(page*20,page*20+19);
            if (owner !== epoch || request !== historyRevision) return;
            if (error) throw new Error('Não foi possível carregar o histórico.');
            if (!data?.length && page > 0) { page--; return loadHistory(); }
            notes = new Map((data || []).map(note => [note.id,note]));
            el('invoiceHistory').innerHTML = (data || []).map(note => {
                const name = note.dados?.destinatario?.nome || 'Destinatário';
                const env = note.ambiente === 'homologacao' ? 'HOMOLOGAÇÃO — SEM VALOR FISCAL' : note.ambiente === 'producao' ? 'Produção' : 'Ainda não enviado';
                const canDownload = ['autorizada','cancelada'].includes(note.status);
                return `<article class="invoice-card"><div class="invoice-card-header"><div><h3>${escape(name)}</h3><p>${note.numero ? 'NF-e '+escape(note.numero)+' · Série '+escape(note.serie) : 'Nota sem número autorizado'}</p></div><span class="status status-${escape(note.status)}">${escape(labels[note.status] || 'Consultar situação')}</span></div><p class="invoice-meta">${escape(env)} · ${escape(note.origem)} · ${escape(new Date(note.criado_em).toLocaleString('pt-BR'))}<br>Referência: ${escape(note.referencia)}${note.chave ? '<br>Chave: '+escape(note.chave) : ''}</p>${note.erro ? `<p class="invoice-error">${escape(note.erro)}</p>` : ''}<div class="actions">${editable(note) ? `<button type="button" class="secondary" data-note-edit="${escape(note.id)}">${note.status === 'rejeitada' ? 'Corrigir rascunho' : 'Abrir rascunho'}</button>` : ''}${note.ambiente ? `<button class="secondary" type="button" data-note-query="${escape(note.id)}">Consultar emissor</button>` : ''}${canDownload ? `<button class="secondary" type="button" data-note-document="${escape(note.id)}" data-type="danfe">Baixar DANFE</button><button class="secondary" type="button" data-note-document="${escape(note.id)}" data-type="xml">Baixar XML</button>` : ''}${note.status === 'autorizada' ? `<button class="secondary" type="button" data-note-cancel="${escape(note.id)}">Solicitar cancelamento</button>` : ''}</div></article>`;
            }).join('') || '<p>Nenhuma nota encontrada.</p>';
            el('historyPage').textContent = `Página ${page+1}`;
            el('previousInvoices').disabled = page === 0; el('nextInvoices').disabled = (page+1)*20 >= (count || 0);
            scheduleQueries(data || []);
        } catch (error) { if (owner === epoch && request === historyRevision) el('invoiceHistory').textContent = error.message; }
    }
    function scheduleQueries(rows) {
        clearTimeout(timer);
        if (document.hidden || el('view-historico').hidden) return;
        const pending = rows.filter(note => ['enviando','processando'].includes(note.status)).slice(0,3);
        if (pending.length) timer = setTimeout(async () => {
            const owner = epoch;
            for (const note of pending) {
                if (owner !== epoch || document.hidden || el('view-historico').hidden) return;
                try { await api({acao:'consultar',id:note.id}); } catch { /* Histórico mantém a última situação conhecida. */ }
            }
            if (owner === epoch) loadHistory(false);
        },20000);
    }
    async function queryNote(id, button) {
        const owner = epoch; button.disabled = true;
        try { const data = await api({acao:'consultar',id}); if (owner === epoch) { message('Situação no emissor: '+(labels[data.status] || 'consulte o histórico')+'.'); await loadHistory(false); } }
        catch (error) { if (owner === epoch) message(error.message); }
        finally { if (owner === epoch) button.disabled = false; }
    }
    async function download(id, type, button) {
        const owner = epoch; button.disabled = true;
        try {
            const blob = await api({acao:'documento',id,tipo:type},true);
            if (owner !== epoch) return;
            const url = URL.createObjectURL(blob), link = document.createElement('a');
            link.href = url; link.download = `nota-${id}.${type === 'xml' ? 'xml' : 'pdf'}`; link.click();
            setTimeout(() => URL.revokeObjectURL(url),10000);
        } catch (error) { if (owner === epoch) message(error.message); }
        finally { if (owner === epoch) button.disabled = false; }
    }
    async function cancel() {
        const reason = el('cancelReason');
        if (!pendingCancel || !reason.reportValidity()) return;
        const owner = epoch; el('confirmCancel').disabled = true;
        try { await api({acao:'cancelar',id:pendingCancel,justificativa:reason.value.trim()}); if (owner === epoch) { el('cancelDialog').close(); message('Solicitação consultada no emissor. Confira a situação atualizada.'); await loadHistory(false); } }
        catch (error) { if (owner === epoch) el('cancelMessage').textContent = error.message; }
        finally { if (owner === epoch) el('confirmCancel').disabled = false; }
    }
    async function importOrder() {
        const id = new URLSearchParams(location.search).get('pedido');
        if (!uuid(id)) return;
        const owner = epoch;
        const existing = await supabaseClient.from('jk_notas_fiscais').select('id').eq('pedido_origem',id).limit(1);
        if (owner !== epoch) return;
        if (existing.error) { message('Não foi possível conferir as notas deste pedido. Consulte o histórico antes de iniciar uma nova emissão.'); return; }
        if (existing.data?.length) { historyOrder=id;showView('historico');message('Este pedido já tem um rascunho ou nota no histórico. Confira o documento existente antes de criar outra emissão.');return; }
        const {data:order,error} = await supabaseClient.from('jk_pedidos').select('id,cliente,endereco,itens,total').eq('id',id).maybeSingle();
        if (owner !== epoch) return;
        if (error || !order) { message('O pedido de origem não foi encontrado. Você pode criar uma nota avulsa.'); return; }
        newNote(); current = {id:crypto.randomUUID(),versao:0,status:'rascunho',pedido_origem:order.id};
        const customer = order.cliente || {}, address = order.endereco || {}, f = form.elements;
        f.origem.value = 'site'; f.presenca_comprador.value = '2'; f.nome.value = customer.nome || ''; f.documento.value = customer.cpf || '';
        for (const key of ['logradouro','numero','bairro','uf','cep']) f[key].value = address[key] || '';
        f.municipio.value = address.cidade || ''; f.email.value = customer.email || '';
        el('invoiceItems').replaceChildren();
        (order.itens || []).forEach(item => addItem({codigo:String(item.produto_id || ''),descricao:item.nome,quantidade:item.quantidade,preco_unitario:item.preco_unitario,unidade:''}));
        el('originOrder').textContent = 'Pedido de origem: '+order.id;
        message('Dados do pedido aproveitados. Complete o código IBGE, a tributação, o pagamento e os valores finais antes de emitir.');
    }
    function lock(text) {
        currentUser = null; epoch++; authRevision++; historyRevision++; clearTimeout(timer);
        config = null; current = null; profiles = []; extras = {}; notes.clear(); pendingCancel = null; reviewedEnvironment = null; busy = false;
        configDirty = false; pendingProfiles = null; pendingExtras = null;
        historyOrder = null; page = 0;
        form.reset(); issuerForm.reset(); el('invoiceItems').replaceChildren(); el('invoiceHistory').replaceChildren();
        el('reviewDialog').close(); el('cancelDialog').close(); el('reviewDetails').replaceChildren(); el('reviewSummary').textContent = ''; el('cancelReason').value = '';
        el('profilesSummary').textContent = 'Nenhum perfil importado.'; el('originOrder').textContent = ''; el('draftState').textContent = ''; el('reviewMessage').textContent = ''; el('cancelMessage').textContent = '';
        el('fiscalWorkspace').hidden = true; el('fiscalLogin').hidden = false; el('fiscalLogout').hidden = true;
        el('fiscalAuthMessage').textContent = text || ''; message('');
    }
    async function refreshAuth() {
        const request = ++authRevision;
        try {
            const {data,error} = await supabaseClient.auth.getUser();
            if (request !== authRevision) return;
            if (error || !data.user) { lock('Entre para acessar a área fiscal.'); return; }
            const result = await supabaseClient.rpc('jk_nf_e_admin');
            if (request !== authRevision) return;
            if (result.error || result.data !== true) { lock('Acesso restrito à equipe. Confira também se o módulo fiscal foi instalado no Supabase.'); return; }
            if (currentUser?.id === data.user.id) return;
            if (currentUser) lock();
            currentUser = data.user;
            const owner = epoch;
            el('fiscalLogin').hidden = true; el('fiscalWorkspace').hidden = false; el('fiscalLogout').hidden = false;
            await loadConfig(); if (owner !== epoch || currentUser?.id !== data.user.id) return;
            newNote(); await importOrder();
        } catch (error) { if (request === authRevision) lock(error.message || 'Não foi possível verificar o acesso.'); }
    }

    el('fiscalLoginForm').addEventListener('submit', async event => {
        event.preventDefault(); const f = event.currentTarget, button = f.querySelector('button'); button.disabled = true;
        try { const {error} = await supabaseClient.auth.signInWithPassword({email:f.elements.email.value.trim(),password:f.elements.password.value}); f.elements.password.value = ''; if (error) throw error; await refreshAuth(); }
        catch { el('fiscalAuthMessage').textContent = 'Não foi possível entrar. Confira seu acesso e tente novamente.'; }
        finally { button.disabled = false; }
    });
    el('fiscalLogout').addEventListener('click', async () => { lock(); await supabaseClient.auth.signOut(); });
    form.addEventListener('submit', event => { event.preventDefault(); saveDraft(); });
    form.addEventListener('input', updateTotal);
    form.elements.forma_pagamento.addEventListener('change', paymentFields);
    form.elements.tipo_integracao.addEventListener('change', paymentFields);
    form.elements.origem.addEventListener('change', () => { form.elements.presenca_comprador.value = {loja:'1',site:'2',whatsapp:'3'}[form.elements.origem.value]; });
    el('addInvoiceItem').addEventListener('click', () => addItem()); el('newDraft').addEventListener('click', newNote);
    el('reviewInvoice').addEventListener('click', review); el('sendInvoice').addEventListener('click', send);
    issuerForm.addEventListener('submit',saveConfig);
    issuerForm.addEventListener('input', () => { configDirty = true; });
    issuerForm.addEventListener('change', () => { configDirty = true; });
    el('discardFiscalConfig').addEventListener('click', async () => {
        const owner = epoch;
        try { await loadConfig(); if (owner === epoch) message('Alterações descartadas. A configuração salva foi restaurada.'); }
        catch (error) { if (owner === epoch) message(error.message); }
    });
    el('fiscalProfilesFile').addEventListener('change', async event => {
        const owner = epoch, file = event.target.files?.[0]; if (!file) return;
        try {
            if (file.size > 1024*1024) throw new Error('O arquivo deve ter até 1 MB.');
            const imported = JSON.parse(await file.text());
            if (owner !== epoch) return;
            if (!Array.isArray(imported.perfis) || !imported.perfis.length || imported.perfis.some(profile => !profile.id || !profile.nome || !profile.campos_fiscais)) throw new Error('O arquivo precisa conter perfis fiscais nomeados e seus campos. Consulte o modelo da documentação.');
            pendingProfiles = imported.perfis; pendingExtras = imported.campos_adicionais || {}; configDirty = true; el('fiscalProfileReviewed').checked = false;
            el('profilesSummary').textContent = pendingProfiles.length+' perfil(is) carregado(s), aguardando salvar: '+pendingProfiles.map(p=>p.nome).join(', ');
            message('Arquivo carregado. Confira os dados e salve a configuração fiscal.');
        } catch (error) { if (owner === epoch) message(error.message || 'Arquivo de perfis inválido.'); }
    });
    document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
    document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => el(button.dataset.close).close()));
    el('reloadInvoices').addEventListener('click', () => loadHistory()); el('invoiceFilter').addEventListener('change', () => { page=0;loadHistory(); });
    el('allInvoices').addEventListener('click', () => { historyOrder=null;page=0;loadHistory(); });
    el('previousInvoices').addEventListener('click', () => { page=Math.max(0,page-1);loadHistory(); }); el('nextInvoices').addEventListener('click', () => { page++;loadHistory(); });
    el('invoiceHistory').addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || busy) return;
        if (button.dataset.noteEdit) { loadNote(notes.get(button.dataset.noteEdit)); return; }
        if (button.dataset.noteQuery) { queryNote(button.dataset.noteQuery,button); return; }
        if (button.dataset.noteDocument) { download(button.dataset.noteDocument,button.dataset.type,button); return; }
        if (button.dataset.noteCancel) { pendingCancel=button.dataset.noteCancel;el('cancelReason').value='';el('cancelMessage').textContent='';el('cancelDialog').showModal(); }
    });
    el('confirmCancel').addEventListener('click',cancel);
    document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden && currentUser && !el('view-historico').hidden) loadHistory(false); });
    supabaseClient.auth.onAuthStateChange((event,session) => {
        if (!session) lock('Entre para acessar a área fiscal.');
        else setTimeout(refreshAuth,0);
    });
    refreshAuth();
})();
