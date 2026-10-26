(function (root) {
    'use strict';
    const digits = value => String(value || '').replace(/\D/g, '');
    function validCPF(value) {
        const cpf = digits(value);
        if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
        for (let length = 9; length <= 10; length++) {
            let sum = 0;
            for (let i = 0; i < length; i++) sum += Number(cpf[i]) * (length + 1 - i);
            const digit = (sum * 10) % 11 % 10;
            if (digit !== Number(cpf[length])) return false;
        }
        return true;
    }
    function normalizePhone(value) {
        let phone = digits(value);
        if ((phone.length === 12 || phone.length === 13) && phone.startsWith('55')) phone = phone.slice(2);
        return phone;
    }
    function validateProfile(input) {
        const result = {
            nome: String(input.nome || '').trim().replace(/\s+/g, ' '),
            cpf: digits(input.cpf), telefone: normalizePhone(input.telefone)
        };
        if (result.nome.length > 150 || !/^\S{2,}(?:\s+\S+)+$/.test(result.nome)) throw new Error('Informe seu nome completo.');
        if (!validCPF(result.cpf)) throw new Error('Informe um CPF válido.');
        if (!/^[1-9]{2}(?:[2-5]\d{7}|9\d{8})$/.test(result.telefone)) throw new Error('Informe um telefone válido com DDD.');
        return result;
    }
    const states = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
    function validateAddress(input) {
        const result = {};
        for (const field of ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf']) result[field] = String(input[field] || '').trim();
        result.cep = digits(result.cep);
        result.uf = result.uf.toUpperCase();
        if (!/^\d{8}$/.test(result.cep)) throw new Error('Informe um CEP com 8 dígitos.');
        if (!states.includes(result.uf)) throw new Error('Selecione o estado.');
        for (const field of ['logradouro', 'numero', 'bairro', 'cidade']) {
            if (!result[field] || result[field].length > 150) throw new Error('Preencha o endereço completo, incluindo número e bairro.');
        }
        if (result.complemento.length > 150) throw new Error('O complemento deve ter até 150 caracteres.');
        return result;
    }
    function escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
    }
    const money = value => Number(value).toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
    function whatsappMessage(order) {
        return ['Olá! Quero acompanhar meu pedido na JK Botinas.', `Pedido: ${order.id}`, '',
            ...order.itens.map(item => `${item.quantidade}x ${item.nome}${item.tamanho ? ' — tamanho ' + item.tamanho : ''}: ${money(item.subtotal)}`),
            '', `Subtotal dos produtos: ${money(order.total)}`, 'Forma de pagamento: Pix pelo site, com confirmação automática do banco.', 'Aguardo a confirmação de disponibilidade e frete.'].join('\n');
    }
    const api = {digits, validCPF, normalizePhone, validateProfile, validateAddress, escapeHTML, money, whatsappMessage, states};
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.JKUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);

