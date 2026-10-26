(function (root) {
    'use strict';

    const labels = {
        pronta: 'Valor definido pela loja', solicitando: 'Preparando Pix',
        ativa: 'Aguardando pagamento', paga: 'Pix confirmado pelo banco',
        expirada: 'Prazo do Pix encerrado'
    };
    const messages = {
        PIX_INDISPONIVEL: 'O pagamento Pix está sendo ativado pela loja. Seu pedido permanece salvo.',
        PIX_AGUARDANDO_LOJA: 'A loja está conferindo a disponibilidade e o frete. O Pix ficará disponível após a definição do valor final.',
        PIX_NAO_AUTORIZADO: 'Entre novamente na sua conta para consultar o pagamento.',
        PIX_DIVERGENTE: 'O pagamento precisa ser conferido pela loja. Entre em contato pelo atendimento.'
    };

    async function request(pedidoId, acao, signal) {
        const {data, error} = await supabaseClient.auth.getSession();
        if (error || !data.session?.access_token) throw new Error(messages.PIX_NAO_AUTORIZADO);
        const response = await fetch('/api/pix', {
            method: 'POST', signal, cache: 'no-store',
            headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token},
            body: JSON.stringify({pedido_id: pedidoId, acao})
        });
        let result;
        try { result = await response.json(); } catch { throw new Error('Não foi possível consultar o Pix. Tente novamente mais tarde.'); }
        if (!response.ok) throw new Error(messages[result.code] || 'Não foi possível consultar o Pix. Tente novamente mais tarde.');
        if (!Object.hasOwn(labels, result.status)) throw new Error('Pagamento indisponível. Tente novamente mais tarde.');
        return result;
    }

    let active = null;
    let revision = 0;
    let timer = null;
    let controller = null;
    const element = id => document.getElementById(id);

    function stop() {
        revision++;
        clearTimeout(timer);
        controller?.abort();
        controller = null;
        active = null;
        const qr = element('pixQRCode');
        if (qr) { qr.removeAttribute('src'); qr.hidden = true; }
        if (element('pixCode')) element('pixCode').value = '';
        if (element('pixCopy')) element('pixCopy').disabled = true;
    }

    function schedule(data) {
        clearTimeout(timer);
        if (active && ['ativa', 'solicitando'].includes(data.status) && !document.hidden) {
            timer = setTimeout(() => refresh('consultar'), 15000);
        }
    }

    async function refresh(acao) {
        if (!active) return;
        const current = active;
        const attempt = ++revision;
        clearTimeout(timer);
        controller?.abort();
        controller = new AbortController();
        element('pixRefresh').disabled = true;
        element('pixMessage').textContent = 'Consultando o pagamento…';
        element('pixCodeArea').hidden = true;
        element('pixQRCode').hidden = true;
        try {
            const data = await request(current.pedidoId, acao, controller.signal);
            if (attempt !== revision || active !== current) return;
            element('pixStatus').textContent = labels[data.status];
            element('pixTotal').textContent = JKUtils.money(data.total);
            element('pixBreakdown').textContent = `Frete: ${JKUtils.money(data.frete)} · Desconto: ${JKUtils.money(data.desconto)}`;
            const canPay = data.status === 'ativa' && typeof data.pix_copia_cola === 'string' && data.pix_copia_cola.length > 0;
            element('pixCode').value = canPay ? data.pix_copia_cola : '';
            element('pixCopy').disabled = !canPay;
            element('pixCodeArea').hidden = !canPay;
            if (canPay && typeof data.qr_data_url === 'string' && data.qr_data_url.length < 150000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qr_data_url)) {
                element('pixQRCode').src = data.qr_data_url;
                element('pixQRCode').hidden = false;
            }
            element('pixExpiry').textContent = data.expira_em && data.status !== 'paga' ? 'Válido até ' + new Date(data.expira_em).toLocaleString('pt-BR') : '';
            element('pixMessage').textContent = data.status === 'paga'
                ? 'Pagamento confirmado pelo Banco do Brasil. A loja seguirá com a preparação do pedido.'
                : data.status === 'expirada'
                    ? 'O prazo desta cobrança terminou. Fale com a loja antes de fazer outro pagamento.'
                    : canPay ? 'Pague no aplicativo do seu banco. Esta tela verifica automaticamente a confirmação.'
                    : 'Use o botão abaixo para preparar a cobrança.';
            element('pixRefresh').hidden = ['paga', 'expirada'].includes(data.status);
            element('pixRefresh').textContent = data.status === 'pronta' ? 'Gerar Pix' : 'Atualizar pagamento';
            element('pixRefresh').dataset.acao = data.status === 'pronta' ? 'cobrar' : 'consultar';
            if (data.status === 'paga') root.dispatchEvent(new CustomEvent('jk:pix-paid', {detail: {pedidoId: current.pedidoId}}));
            schedule(data);
        } catch (error) {
            if (attempt !== revision || error.name === 'AbortError') return;
            element('pixStatus').textContent = 'Pagamento Pix';
            element('pixMessage').textContent = error.message || 'Não foi possível consultar o Pix.';
            // Uma falha de rede não cancela a cobrança. Reutilizamos sempre o mesmo pedido.
            element('pixRefresh').hidden = false;
            element('pixRefresh').textContent = 'Tentar novamente';
            element('pixRefresh').dataset.acao = acao;
        } finally {
            if (attempt === revision) element('pixRefresh').disabled = false;
        }
    }

    function open(pedidoId) {
        if (!pedidoId || !supabaseClient) return;
        stop();
        active = {pedidoId};
        element('pixOrder').textContent = 'Pedido ' + pedidoId;
        element('pixTotal').textContent = '';
        element('pixBreakdown').textContent = '';
        element('pixExpiry').textContent = '';
        element('pixStatus').textContent = 'Pagamento Pix';
        element('pixRefresh').hidden = false;
        element('pixCodeArea').hidden = true;
        element('pixDialog').showModal();
        refresh('cobrar');
    }

    function init() {
        if (!element('pixDialog')) return;
        element('pixDialog').addEventListener('close', stop);
        element('pixClose').addEventListener('click', () => element('pixDialog').close());
        element('pixRefresh').addEventListener('click', () => refresh(element('pixRefresh').dataset.acao || 'consultar'));
        element('pixCopy').addEventListener('click', async () => {
            const code = element('pixCode').value;
            if (!code) return;
            const attempt = revision;
            try {
                await navigator.clipboard.writeText(code);
                if (attempt === revision) element('pixMessage').textContent = 'Código copiado. Cole na opção Pix Copia e Cola do seu banco.';
            } catch {
                if (attempt !== revision) return;
                element('pixCode').focus(); element('pixCode').select();
                element('pixMessage').textContent = 'Selecione e copie o código acima.';
            }
        });
        document.addEventListener('click', event => {
            const button = event.target.closest('[data-pagar-pix]');
            if (button) open(button.dataset.pagarPix);
        });
        document.addEventListener('visibilitychange', () => {
            clearTimeout(timer);
            if (!document.hidden && active) refresh('consultar');
        });
        root.addEventListener('jk:locked', () => { stop(); element('pixDialog').close(); });
        root.addEventListener('jk:ready', event => {
            if (event.detail?.changed && active) { stop(); element('pixDialog').close(); }
        });
    }

    root.JKPix = {request, label: status => labels[status] || 'Aguardando definição do frete', open};
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})(window);
