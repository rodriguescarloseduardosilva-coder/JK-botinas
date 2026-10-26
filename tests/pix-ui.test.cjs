'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function ui(fetchImpl, getSession = async () => ({data: {session: {access_token: 'jwt-customer'}}})) {
    const elements = new Map();
    const emitted = [];
    const windowEvents = new Map();
    const docEvents = new Map();
    let pendingTimer = null;
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            id, textContent: '', value: '', hidden: false, disabled: false, open: false,
            dataset: {}, events: new Map(),
            addEventListener(name, callback) { this.events.set(name, callback); },
            removeAttribute(name) { delete this[name]; },
            showModal() { this.open = true; },
            close() { this.open = false; this.events.get('close')?.(); },
            focus() {}, select() {}
        });
        return elements.get(id);
    }
    const window = {
        addEventListener(name, callback) { windowEvents.set(name, callback); },
        dispatchEvent(event) { emitted.push(event); windowEvents.get(event.type)?.(event); }
    };
    const context = vm.createContext({
        window, document: {readyState: 'complete', hidden: false, getElementById: element,
            addEventListener(name, callback) { docEvents.set(name, callback); }},
        supabaseClient: {auth: {getSession}}, fetch: fetchImpl,
        JKUtils: {money: value => `R$ ${value}`}, AbortController,
        CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data?.detail; } },
        navigator: {clipboard: {writeText: async () => {}}},
        setTimeout(callback) { pendingTimer = callback; return 1; }, clearTimeout() { pendingTimer = null; }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../pix.js'), 'utf8'), context);
    return {api: window.JKPix, element, emitted, lock: () => windowEvents.get('jk:locked')(),
        changeAccount: () => windowEvents.get('jk:ready')({detail: {changed: true}}), timer: () => pendingTimer};
}
const response = data => ({ok: true, json: async () => data});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('browser envia apenas pedido/ação e JWT; nunca manda preço ao servidor', async () => {
    let request;
    const view = ui(async (url, options) => { request = {url, ...options}; return response({status: 'ativa'}); });
    await view.api.request('pedido-1', 'cobrar');
    assert.equal(request.url, '/api/pix');
    assert.deepEqual(JSON.parse(request.body), {pedido_id: 'pedido-1', acao: 'cobrar'});
    assert.equal(request.headers.Authorization, 'Bearer jwt-customer');
    assert.equal(request.cache, 'no-store');
});

test('sem sessão não faz chamada bancária; API desativada exibe mensagem sem falso sucesso', async () => {
    const locked = ui(() => { throw Error('não deve chamar'); }, async () => ({data: {session: null}}));
    await assert.rejects(locked.api.request('p', 'cobrar'), /Entre novamente/);
    const disabled = ui(async () => ({ok: false, json: async () => ({code: 'PIX_INDISPONIVEL', message: 'segredo interno'})}));
    await assert.rejects(disabled.api.request('p', 'cobrar'), /está sendo ativado/);
    const invalid = ui(async () => response({status: 'APROVADO_PELO_CLIENTE'}));
    await assert.rejects(invalid.api.request('p', 'cobrar'), /indisponível/);
});

test('resposta tardia de outro pedido não mostra QR nem confirma pagamento', async () => {
    const pending = [];
    const view = ui(() => new Promise(resolve => pending.push(resolve)));
    view.api.open('primeiro'); await tick();
    view.api.open('segundo'); await tick();
    pending[0](response({status: 'paga', total: 10})); await tick();
    assert.equal(view.emitted.length, 0);
    pending[1](response({status: 'ativa', total: 20, frete: 0, desconto: 0, pix_copia_cola: 'copia-cola-segundo', qr_data_url: 'https://example.com/qr'})); await tick();
    assert.equal(view.element('pixCode').value, 'copia-cola-segundo');
    assert.equal(view.element('pixQRCode').hidden, true);
    assert.ok(view.timer());
});

test('logout apaga código, fecha tela, cancela consulta e ignora resposta posterior', async () => {
    let resolve;
    const view = ui(() => new Promise(done => { resolve = done; }));
    view.api.open('pedido-1'); await tick();
    view.lock();
    resolve(response({status: 'paga', total: 30})); await tick();
    assert.equal(view.element('pixCode').value, '');
    assert.equal(view.element('pixDialog').open, false);
    assert.equal(view.emitted.length, 0);
    assert.equal(view.timer(), null);
});

test('só resposta paga do servidor mostra confirmação e encerra polling', async () => {
    const view = ui(async () => response({status: 'paga', total: 30, frete: 5, desconto: 0}));
    view.api.open('pedido-1'); await tick();
    assert.match(view.element('pixMessage').textContent, /confirmado pelo Banco do Brasil/);
    assert.equal(view.element('pixRefresh').hidden, true);
    assert.equal(view.element('pixCopy').disabled, true);
    assert.equal(view.emitted.length, 1);
    assert.equal(view.timer(), null);
});

test('troca de conta sem logout limpa o pagamento e ignora resposta da sessão anterior', async () => {
    let resolve;
    const view = ui(() => new Promise(done => { resolve = done; }));
    view.api.open('pedido-da-conta-anterior'); await tick();
    view.changeAccount();
    resolve(response({status: 'ativa', total: 20, pix_copia_cola: 'codigo-anterior'})); await tick();
    assert.equal(view.element('pixCode').value, '');
    assert.equal(view.element('pixDialog').open, false);
    assert.equal(view.timer(), null);
});
