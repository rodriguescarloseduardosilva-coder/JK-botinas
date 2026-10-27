'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = readFileSync(join(__dirname,'../fiscal.html'),'utf8');
const SCRIPT = readFileSync(join(__dirname,'../fiscal.js'),'utf8');
const ADMIN = { id: '10000000-0000-4000-8000-000000000001' };
const SECOND_ADMIN = { id: '10000000-0000-4000-8000-000000000002' };
const CUSTOMER = { id: '10000000-0000-4000-8000-000000000003' };
const PROFILE = { id: 'perfil-base',nome: 'Perfil ativo',campos_fiscais: { codigo_ncm: '64039190',cfop: '5102',icms_situacao_tributaria: '102',unidade_comercial: 'UN' } };
const CONFIG = {
    id: true,versao: 7,dados: {
        emitente: { cnpj: '00000000000000',nome: 'Empresa de teste',inscricao_estadual: '123456',uf: 'DF',regime_tributario: 1,cep: '72000000',municipio: 'Brasília',logradouro: 'Rua da Empresa',numero: '1',bairro: 'Centro' },
        perfis: [PROFILE],campos_adicionais: { informacoes_adicionais_contribuinte: 'Configuração salva' },revisado_contabilidade: true
    }
};
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const pause = () => new Promise(resolve => setTimeout(resolve,2));
async function until(predicate, description) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Tempo esgotado: ' + description);
        await pause();
    }
}
async function flush() { for (let i=0;i<5;i++) await pause(); }
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes,no) => { resolve=yes;reject=no; });
    return { promise,resolve,reject };
}
const jsonResponse = value => ({ ok:true,status:200,json:async () => clone(value) });

async function harness(t,options = {}) {
    const errors = [], rpcCalls = [], fromCalls = [], apiCalls = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError',error => errors.push(error.message));
    const dom = new JSDOM(HTML,{ url:'https://jk.example.test/fiscal.html',runScripts:'outside-only',virtualConsole });
    const { window } = dom, { document } = window;
    t.after(async () => { await flush();window.close(); });
    Object.defineProperty(window.crypto,'randomUUID',{ value:randomUUID });
    window.HTMLDialogElement.prototype.showModal = function () { this.open=true; };
    window.HTMLDialogElement.prototype.close = function () { this.open=false; };
    const state = {
        user:options.user === undefined ? clone(ADMIN) : clone(options.user),
        admin:options.admin !== false,config:clone(CONFIG),notes:new Map(),authCallback:null,signOuts:0
    };
    const token = () => state.user ? 'session-' + state.user.id : null;
    async function defaultRpc(name,args) {
        if (name === 'jk_nf_e_admin') return { data:Boolean(state.user && state.admin),error:null };
        if (name === 'jk_nf_salvar_rascunho') {
            const note = { id:args.p_id,origem:args.p_origem,pedido_origem:args.p_pedido_origem,dados:clone(args.p_dados),
                versao:args.p_versao+1,status:'rascunho',referencia:'jk'+args.p_id.replaceAll('-',''),criado_em:'2026-10-26T12:00:00Z',ambiente:null };
            state.notes.set(note.id,note);
            return { data:clone(note),error:null };
        }
        if (name === 'jk_nf_salvar_config') {
            state.config = { id:true,versao:(state.config?.versao || 0)+1,dados:clone(args.p_dados) };
            return { data:clone(state.config),error:null };
        }
        throw new Error('RPC não prevista no teste: ' + name);
    }
    async function defaultFrom(request) {
        if (request.table === 'jk_nf_config') return { data:clone(state.config),error:null };
        if (request.table === 'jk_notas_fiscais') {
            let rows = [...state.notes.values()];
            for (const [key,value] of request.filters) rows = rows.filter(row => row[key] === value);
            return { data:clone(rows),count:rows.length,error:null };
        }
        throw new Error('Tabela não prevista no teste: ' + request.table);
    }
    function from(table) {
        const request = { table,filters:[],user:clone(state.user),operation:null };
        const execute = async operation => {
            request.operation=operation; fromCalls.push(clone(request));
            return options.from ? options.from(clone(request),defaultFrom,state) : defaultFrom(request);
        };
        const query = {
            select() { return this; },eq(key,value) { request.filters.push([key,value]);return this; },
            order() { return this; },limit() { return this; },
            maybeSingle() { return execute('maybeSingle'); },range() { return execute('range'); },
            then(resolve,reject) { return execute('await').then(resolve,reject); }
        };
        return query;
    }
    window.supabaseClient = {
        auth: {
            getUser:async () => ({ data:{ user:clone(state.user) },error:null }),
            getSession:async () => {
                const normal=() => ({ data:{ session:state.user ? { access_token:token(),user:clone(state.user) } : null },error:null });
                return options.getSession ? options.getSession(normal,state) : normal();
            },
            onAuthStateChange(callback) { state.authCallback=callback;return { data:{ subscription:{ unsubscribe() {} } } }; },
            signInWithPassword:async () => ({ error:null }),
            signOut:async () => { state.signOuts++;state.user=null;state.authCallback?.('SIGNED_OUT',null);return { error:null }; }
        },
        from,
        async rpc(name,args) {
            rpcCalls.push({ name,args:clone(args),user:clone(state.user) });
            return options.rpc ? options.rpc(name,clone(args),defaultRpc,state) : defaultRpc(name,args);
        }
    };
    window.fetch = async (url,init) => {
        assert.equal(url,'/api/fiscal','nenhuma rede externa é permitida no teste');
        const request = { url,body:JSON.parse(init.body),headers:clone(init.headers),method:init.method,cache:init.cache };
        apiCalls.push(request);
        if (options.fetch) return options.fetch(request,state);
        if (request.body.acao === 'prever') return jsonResponse({ ambiente:options.environment || 'homologacao',habilitado:true,total:99.9 });
        if (request.body.acao === 'emitir') return jsonResponse({ status:'processando' });
        if (request.body.acao === 'consultar') return jsonResponse({ status:'processando' });
        throw new Error('Ação de API não prevista: ' + request.body.acao);
    };
    window.eval(SCRIPT);
    const h = {
        window,document,state,errors,rpcCalls,fromCalls,apiCalls,
        el:name => document.getElementById(name),
        click:name => document.getElementById(name).click(),
        submit:name => document.getElementById(name).dispatchEvent(new window.Event('submit',{ bubbles:true,cancelable:true })),
        switchUser(user,admin = true,config) {
            state.user=clone(user);state.admin=admin;
            if (config) state.config=clone(config);
            state.authCallback(user ? 'SIGNED_IN' : 'SIGNED_OUT',user ? { access_token:token() } : null);
        },
        async importProfiles(data,textPromise) {
            const input=document.getElementById('fiscalProfilesFile');
            Object.defineProperty(input,'files',{ configurable:true,value:[{ size:256,text:() => textPromise || Promise.resolve(JSON.stringify(data)) }] });
            input.dispatchEvent(new window.Event('change',{ bubbles:true }));
            await flush();
        }
    };
    if (options.waitReady !== false) {
        await until(() => state.admin && state.user ? h.el('invoiceItems').children.length === 1 : h.el('fiscalAuthMessage').textContent !== 'Verificando acesso…','inicialização da área fiscal');
        assert.deepEqual(errors,[]);
    }
    return h;
}

function setField(h,name,value,formId='invoiceForm') {
    const input=h.el(formId).elements.namedItem(name);
    assert.ok(input,'campo do formulário: ' + name);
    input.value=String(value);
    input.dispatchEvent(new h.window.Event(input.tagName === 'SELECT' ? 'change' : 'input',{ bubbles:true }));
}
function fillInvoice(h,name='Cliente atual') {
    const values={ origem:'loja',presenca_comprador:'1',consumidor_final:'1',natureza_operacao:'VENDA',tipo_documento:'cpf',documento:'98765432109',nome:name,
        indicador_ie:'9',email:'cliente@example.test',cep:'72000000',uf:'DF',municipio:'Brasília',codigo_municipio:'5300108',logradouro:'Rua Teste',numero:'10',bairro:'Centro',
        frete:'0',desconto:'0',forma_pagamento:'01',indicador_pagamento:'0' };
    for (const [key,value] of Object.entries(values)) setField(h,key,value);
    const row=h.el('invoiceItems').firstElementChild;
    for (const [key,value] of Object.entries({ codigo:'SKU-1',descricao:'Botina de teste',perfil_id:'perfil-base',unidade:'UN',quantidade:'1',preco_unitario:'99.90' })) {
        const input=row.querySelector(`[name="${key}"]`); input.value=value;
        input.dispatchEvent(new h.window.Event(key === 'perfil_id' ? 'change' : 'input',{ bubbles:true }));
    }
    assert.equal(h.el('invoiceForm').checkValidity(),true,[...h.el('invoiceForm').elements].filter(e => e.willValidate && !e.validity.valid).map(e => e.name).join(', '));
}
const savedCalls = h => h.rpcCalls.filter(call => call.name === 'jk_nf_salvar_rascunho');
async function saveDraft(h) {
    const count=savedCalls(h).length; h.submit('invoiceForm');
    await until(() => savedCalls(h).length > count && /Rascunho salvo/.test(h.el('draftState').textContent),'salvar rascunho');
}
async function openReview(h) {
    h.click('reviewInvoice');
    await until(() => h.el('reviewDialog').open,'abrir revisão');
}

test('administrador salva, revisa e emite com versão salva, ambiente explícito e JWT', async t => {
    const h=await harness(t); fillInvoice(h);
    await saveDraft(h);
    assert.equal(savedCalls(h)[0].args.p_versao,0);
    assert.equal(savedCalls(h)[0].args.p_dados.config_versao,7);
    assert.equal(savedCalls(h)[0].args.p_origem,'loja');
    await openReview(h);
    assert.equal(savedCalls(h)[1].args.p_versao,1);
    assert.match(h.el('reviewDetails').textContent,/HOMOLOGAÇÃO — SEM VALOR FISCAL/);
    h.click('sendInvoice'); await flush();
    assert.equal(h.apiCalls.some(call => call.body.acao === 'emitir'),false);
    h.el('reviewAccepted').checked=true; h.click('sendInvoice');
    await until(() => h.apiCalls.some(call => call.body.acao === 'emitir') && !h.el('reviewDialog').open,'envio após revisão');
    const send=h.apiCalls.find(call => call.body.acao === 'emitir');
    assert.deepEqual(send.body,{ acao:'emitir',id:savedCalls(h)[1].args.p_id,versao:2,ambiente:'homologacao' });
    assert.equal(send.headers.Authorization,'Bearer session-' + ADMIN.id);
    assert.equal(send.cache,'no-store');
    assert.match(h.el('fiscalMessage').textContent,/Em processamento/);
    assert.equal(h.el('view-historico').hidden,false);
    assert.deepEqual(h.errors,[]);
});

test('revisão de produção mostra aviso e usa ambiente devolvido pelo servidor', async t => {
    const h=await harness(t,{ environment:'producao' }); fillInvoice(h); await openReview(h);
    assert.match(h.el('reviewDetails').textContent,/PRODUÇÃO — emissão de nota fiscal real/);
    h.el('reviewAccepted').checked=true; h.click('sendInvoice');
    await until(() => h.apiCalls.some(call => call.body.acao === 'emitir'),'envio em ambiente revisado');
    assert.equal(h.apiCalls.find(call => call.body.acao === 'emitir').body.ambiente,'producao');
});

test('cliente comum permanece bloqueado e não carrega configuração nem salva/emite', async t => {
    const h=await harness(t,{ user:CUSTOMER,admin:false });
    assert.equal(h.el('fiscalWorkspace').hidden,true);
    assert.match(h.el('fiscalAuthMessage').textContent,/Acesso restrito/);
    h.submit('invoiceForm'); h.submit('issuerForm'); h.click('reviewInvoice'); h.el('reviewAccepted').checked=true;h.click('sendInvoice');
    await flush();
    assert.equal(h.fromCalls.length,0);
    assert.equal(h.rpcCalls.some(call => call.name !== 'jk_nf_e_admin'),false);
    assert.equal(h.apiCalls.length,0);
});

test('logout durante salvamento ignora resultado antigo e limpa dados pessoais', async t => {
    const pending=deferred();
    const h=await harness(t,{ rpc:(name,args,normal) => name === 'jk_nf_salvar_rascunho' ? pending.promise : normal(name,args) });
    fillInvoice(h,'Cliente da sessão encerrada'); h.submit('invoiceForm');
    await until(() => savedCalls(h).length === 1,'início de salvamento');
    h.click('fiscalLogout');
    const args=savedCalls(h)[0].args;
    pending.resolve({ data:{ id:args.p_id,dados:args.p_dados,versao:1,status:'rascunho' },error:null });
    await flush();
    assert.equal(h.el('fiscalWorkspace').hidden,true);
    assert.equal(h.el('invoiceItems').children.length,0);
    assert.equal(h.el('invoiceForm').elements.nome.value,'');
    assert.equal(h.el('draftState').textContent,'');
    assert.equal(h.el('reviewDialog').open,false);
    assert.equal(h.apiCalls.length,0);
    assert.equal(h.state.signOuts,1);
});

test('troca de administrador durante prévia ignora resposta da sessão anterior', async t => {
    const pending=deferred();
    const h=await harness(t,{ fetch:request => request.body.acao === 'prever' ? pending.promise : jsonResponse({ status:'processando' }) });
    fillInvoice(h,'Destinatário antigo'); h.click('reviewInvoice');
    await until(() => h.apiCalls.length === 1,'prévia pendente');
    h.switchUser(SECOND_ADMIN);
    await until(() => h.el('invoiceItems').children.length === 1 && !h.el('invoiceForm').elements.nome.value,'nova sessão administrativa');
    fillInvoice(h,'Destinatário da nova sessão');
    pending.resolve(jsonResponse({ ambiente:'producao',habilitado:true,total:99.9 }));
    await flush();
    assert.equal(h.el('reviewDialog').open,false);
    assert.equal(h.el('reviewSummary').textContent,'');
    assert.equal(h.el('invoiceForm').elements.nome.value,'Destinatário da nova sessão');
    assert.equal(h.el('view-nova').hidden,false);
});

test('resposta de emissão antiga não muda a tela ou o rascunho da nova sessão', async t => {
    const pending=deferred();
    const h=await harness(t,{ fetch:request => request.body.acao === 'emitir' ? pending.promise : jsonResponse({ ambiente:'homologacao',habilitado:true,total:99.9 }) });
    fillInvoice(h); await openReview(h); h.el('reviewAccepted').checked=true;h.click('sendInvoice');
    await until(() => h.apiCalls.some(call => call.body.acao === 'emitir'),'emissão pendente');
    h.switchUser(SECOND_ADMIN);
    await until(() => h.el('invoiceItems').children.length === 1 && !h.el('invoiceForm').elements.nome.value,'troca de sessão durante emissão');
    fillInvoice(h,'Novo rascunho independente');
    pending.resolve(jsonResponse({ status:'autorizada' })); await flush();
    assert.equal(h.el('invoiceForm').elements.nome.value,'Novo rascunho independente');
    assert.equal(h.el('view-nova').hidden,false);
    assert.equal(h.el('fiscalMessage').textContent,'');
    assert.equal(h.fromCalls.filter(call => call.table === 'jk_notas_fiscais').length,0);
});

test('logout enquanto getSession está pendente impede fetch de emissão mesmo se o token chegar depois', async t => {
    const pending=deferred();let sessions=0;
    const h=await harness(t,{ getSession:normal => ++sessions === 2 ? pending.promise : normal() });
    fillInvoice(h);await openReview(h);
    h.el('reviewAccepted').checked=true;h.click('sendInvoice');
    await until(() => sessions === 2,'token de emissão pendente');
    assert.equal(h.apiCalls.filter(call => call.body.acao === 'emitir').length,0);
    h.click('fiscalLogout');
    pending.resolve({ data:{ session:{ access_token:'session-' + ADMIN.id,user:clone(ADMIN) } },error:null });
    await flush();
    assert.equal(h.apiCalls.filter(call => call.body.acao === 'emitir').length,0);
    assert.equal(h.apiCalls.length,1,'somente a prévia já concluída acessou a API');
    assert.equal(h.el('fiscalWorkspace').hidden,true);
    assert.equal(h.el('reviewDialog').open,false);
    assert.equal(h.el('reviewMessage').textContent,'');
    assert.deepEqual(h.errors,[]);
});

test('configuração carregada na sessão antiga não apaga formulário da sessão nova', async t => {
    const pending=deferred();
    const h=await harness(t,{ waitReady:false,from:(request,normal) => request.table === 'jk_nf_config' && request.user.id === ADMIN.id ? pending.promise : normal(request) });
    await until(() => h.fromCalls.length === 1,'configuração pendente da primeira sessão');
    h.switchUser(SECOND_ADMIN);
    await until(() => h.el('invoiceItems').children.length === 1,'configuração da segunda sessão');
    fillInvoice(h,'Formulário da segunda sessão');
    pending.resolve({ data:clone(CONFIG),error:null }); await flush();
    assert.equal(h.el('invoiceForm').elements.nome.value,'Formulário da segunda sessão');
    assert.equal(h.el('invoiceItems').children.length,1);
    assert.equal(h.el('fiscalWorkspace').hidden,false);
});

test('histórico pendente não repõe dados após logout', async t => {
    const pending=deferred();
    const h=await harness(t,{ from:(request,normal) => request.table === 'jk_notas_fiscais' ? pending.promise : normal(request) });
    h.document.querySelector('[data-view="historico"]').click();
    await until(() => h.fromCalls.some(call => call.table === 'jk_notas_fiscais'),'histórico pendente');
    h.click('fiscalLogout');
    pending.resolve({ data:[{ id:randomUUID(),status:'rascunho',origem:'loja',referencia:'antiga',dados:{ destinatario:{ nome:'Dado da sessão antiga' } },criado_em:'2026-10-26T12:00:00Z' }],count:1,error:null });
    await flush();
    assert.equal(h.el('invoiceHistory').textContent,'');
    assert.equal(h.el('fiscalWorkspace').hidden,true);
});

test('perfis importados ficam pendentes sem alterar opções ativas ou liberar revisão/emissão', async t => {
    const h=await harness(t); fillInvoice(h); await saveDraft(h);
    const changed={ perfis:[{ ...clone(PROFILE),nome:'Perfil pendente',campos_fiscais:{ ...PROFILE.campos_fiscais,codigo_ncm:'99999999' } }],campos_adicionais:{ informacoes_adicionais_contribuinte:'Somente pendente' } };
    await h.importProfiles(changed);
    assert.match(h.el('profilesSummary').textContent,/aguardando salvar/);
    assert.equal(h.el('fiscalProfileReviewed').checked,false);
    h.click('addInvoiceItem');
    const second=h.el('invoiceItems').lastElementChild;
    assert.match(second.querySelector('[name="perfil_id"]').textContent,/Perfil ativo/);
    assert.equal(second.querySelector('[name="perfil_id"]').textContent.includes('Perfil pendente'),false);
    second.querySelector('[data-remove-item]').click();
    const saves=savedCalls(h).length;
    h.click('reviewInvoice'); await flush();
    assert.equal(savedCalls(h).length,saves);
    assert.equal(h.apiCalls.length,0);
    assert.match(h.el('fiscalMessage').textContent,/Salve ou descarte/);
    h.el('reviewAccepted').checked=true;h.click('sendInvoice');await flush();
    assert.equal(h.apiCalls.length,0);
    assert.match(h.el('reviewMessage').textContent,/Salve ou descarte/);
});

test('descartar importação restaura perfis e campos adicionais já salvos', async t => {
    const h=await harness(t); fillInvoice(h);
    await h.importProfiles({ perfis:[{ ...clone(PROFILE),nome:'Não salvar este perfil' }],campos_adicionais:{ informacoes_adicionais_contribuinte:'Não salvar este texto' } });
    h.click('discardFiscalConfig');
    await until(() => /Alterações descartadas/.test(h.el('fiscalMessage').textContent),'descartar importação');
    assert.match(h.el('profilesSummary').textContent,/Perfil ativo/);
    assert.equal(h.el('profilesSummary').textContent.includes('Não salvar'),false);
    h.submit('issuerForm');
    await until(() => /Configuração salva/.test(h.el('fiscalMessage').textContent),'salvar configuração restaurada');
    const save=h.rpcCalls.find(call => call.name === 'jk_nf_salvar_config');
    assert.deepEqual(save.args.p_dados.perfis,CONFIG.dados.perfis);
    assert.deepEqual(save.args.p_dados.campos_adicionais,CONFIG.dados.campos_adicionais);
});

test('salvar importação confirmada promove perfis e versão da configuração antes de revisar', async t => {
    const h=await harness(t);
    const imported={ perfis:[{ ...clone(PROFILE),nome:'Perfil aprovado novo' }],campos_adicionais:{ informacoes_adicionais_contribuinte:'Configuração nova' } };
    await h.importProfiles(imported);
    h.el('fiscalProfileReviewed').checked=true;h.submit('issuerForm');
    await until(() => /Configuração salva/.test(h.el('fiscalMessage').textContent),'salvar novos perfis');
    const save=h.rpcCalls.find(call => call.name === 'jk_nf_salvar_config');
    assert.deepEqual(save.args.p_dados.perfis,imported.perfis);
    assert.deepEqual(save.args.p_dados.campos_adicionais,imported.campos_adicionais);
    assert.match(h.el('invoiceItems').querySelector('[name="perfil_id"]').textContent,/Perfil aprovado novo/);
    fillInvoice(h); await openReview(h);
    assert.equal(savedCalls(h).at(-1).args.p_dados.config_versao,8);
    assert.match(h.el('reviewDetails').textContent,/Perfil aprovado novo/);
});

test('leitura tardia de arquivo importado após logout não restaura configuração', async t => {
    const pending=deferred(); const h=await harness(t);
    await h.importProfiles({},pending.promise);
    h.click('fiscalLogout');
    pending.resolve(JSON.stringify({ perfis:[{ ...PROFILE,nome:'Perfil da sessão antiga' }] }));await flush();
    assert.equal(h.el('profilesSummary').textContent,'Nenhum perfil importado.');
    assert.equal(h.el('fiscalWorkspace').hidden,true);
    assert.equal(h.rpcCalls.some(call => call.name === 'jk_nf_salvar_config'),false);
});

test('erro de JSON importado depois do logout não injeta mensagem da sessão anterior', async t => {
    const pending=deferred();const h=await harness(t);
    await h.importProfiles({},pending.promise);
    h.click('fiscalLogout');
    const loginMessage=h.el('fiscalAuthMessage').textContent;
    pending.resolve('{JSON inválido da sessão anterior');await flush();
    assert.equal(h.el('fiscalMessage').textContent,'');
    assert.equal(h.el('fiscalAuthMessage').textContent,loginMessage);
    assert.equal(h.el('profilesSummary').textContent,'Nenhum perfil importado.');
    assert.equal(h.el('fiscalWorkspace').hidden,true);
    assert.deepEqual(h.errors,[]);
});

test('campos condicionais de cartão e outros pagamentos exigem somente os dados aplicáveis', async t => {
    const h=await harness(t);fillInvoice(h);
    const f=h.el('invoiceForm').elements;
    assert.equal(f.tipo_integracao.required,false);
    assert.equal(f.cnpj_credenciadora.required,false);
    setField(h,'forma_pagamento','03');
    assert.equal(f.tipo_integracao.required,true);
    setField(h,'tipo_integracao','1');
    assert.equal(f.cnpj_credenciadora.required,true);
    assert.equal(f.numero_autorizacao.required,true);
    assert.equal(h.el('invoiceForm').checkValidity(),false);
    setField(h,'cnpj_credenciadora','00.000.000/0000-00');setField(h,'numero_autorizacao','AUTH-123');
    await saveDraft(h);
    assert.deepEqual(savedCalls(h).at(-1).args.p_dados.pagamento,{ forma:'03',indicador_pagamento:'0',tipo_integracao:'1',cnpj_credenciadora:'00000000000000',numero_autorizacao:'AUTH-123' });
    setField(h,'forma_pagamento','99');
    assert.equal(f.tipo_integracao.required,false);
    assert.equal(f.cnpj_credenciadora.required,false);
    assert.equal(f.descricao_pagamento.required,true);
    setField(h,'descricao_pagamento','Pagamento informado pela loja');await saveDraft(h);
    assert.deepEqual(savedCalls(h).at(-1).args.p_dados.pagamento,{ forma:'99',indicador_pagamento:'0',descricao_pagamento:'Pagamento informado pela loja' });
});
