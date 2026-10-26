'use strict';
const CATEGORY_EMOJI = {botas:'👢', roupas:'👕', chapeus:'🤠', acessorios:'🤎'};
let productsById = new Map();
let sizesById = new Map();
let cart = [];
let activeCustomerId = null;
let loadingRevision = 0;
let checkoutBusy = false;
let activeCategory = 'todos';
let pendingOrderKey = null;
const $ = id => document.getElementById(id);
const escapeHTML = JKUtils.escapeHTML;
const money = JKUtils.money;

function readStorage(key, fallback) {
    try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStorage(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Navegação continua sem persistência. */ }
}
function cartKey() { return 'jk_cart:' + activeCustomerId; }
function saveCart() {
    if (activeCustomerId) writeStorage(cartKey(), cart);
}
function availableStock(id, size) {
    const sizes = sizesById.get(id) || [];
    if (sizes.length) return Number(sizes.find(item => item.tamanho === size)?.estoque || 0);
    return Number(productsById.get(id)?.estoque || 0);
}
async function loadProducts() {
    const customerId = JKAuth.customer?.id;
    if (!customerId) return;
    const request = ++loadingRevision;
    $('productsGrid').textContent = 'Carregando produtos…';
    try {
        const [productsResult, sizesResult] = await Promise.all([
            supabaseClient.from('produtos').select('*').order('criado_em'),
            supabaseClient.from('produto_tamanhos').select('produto_id,tamanho,estoque').order('tamanho')
        ]);
        if (request !== loadingRevision || JKAuth.customer?.id !== customerId) return;
        if (productsResult.error || sizesResult.error) throw new Error('Catálogo indisponível');
        productsById = new Map((productsResult.data || []).map(item => [String(item.id), item]));
        sizesById = new Map();
        for (const size of sizesResult.data || []) {
            const id = String(size.produto_id);
            if (!sizesById.has(id)) sizesById.set(id, []);
            sizesById.get(id).push(size);
        }
        if (activeCustomerId !== customerId) {
            activeCustomerId = customerId;
            const saved = readStorage(cartKey(), []);
            cart = Array.isArray(saved) ? saved.filter(item => item && typeof item.produto_id === 'string' && (item.tamanho === null || typeof item.tamanho === 'string') && Number.isInteger(item.quantidade) && item.quantidade > 0 && item.quantidade <= 99) : [];
        }
        cart = cart.filter(item => productsById.has(item.produto_id));
        saveCart();
        $('productsGrid').innerHTML = [...productsById.values()].map(renderProductCard).join('') || '<p>Nenhum produto disponível no momento.</p>';
        applyFilters();
        updateCart();
    } catch {
        if (request === loadingRevision) $('productsGrid').innerHTML = '<p>Não foi possível carregar os produtos. <button class="text-action" type="button" onclick="loadProducts()">Tentar novamente</button></p>';
    }
}
function safeImage(value) {
    if (!value) return '';
    try {
        const source = String(value).trim();
        const url = new URL(source, location.href);
        // Permite URLs públicas e também caminhos locais da pasta Fotos.
        return ['https:', 'http:', 'file:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
}

function localImageCandidates(productName) {
    const name = String(productName || '').trim();
    if (!name) return [];
    return [
        `Fotos/${name} 01.jpg`,
        `Fotos/${name} 01.jpeg`,
        `Fotos/${name}.jpg`,
        `Fotos/${name}.jpeg`,
        `Fotos/${name}.png`
    ];
}

// Tenta as imagens locais quando a URL do Supabase está vazia ou indisponível.
window.tryNextProductImage = function (image) {
    let alternatives = [];
    try { alternatives = JSON.parse(image.dataset.fallbacks || '[]'); } catch { alternatives = []; }
    const next = alternatives.shift();
    if (next) {
        image.dataset.fallbacks = JSON.stringify(alternatives);
        image.src = next;
        return;
    }
    const placeholder = document.createElement('div');
    placeholder.className = 'product-placeholder';
    placeholder.textContent = '🛍️';
    image.replaceWith(placeholder);
};

function renderProductCard(product) {
    const id = String(product.id);
    const sizes = sizesById.get(id) || [];
    const available = sizes.length ? sizes.some(size => Number(size.estoque) > 0) : Number(product.estoque) > 0;
    const imageURL = safeImage(product.imagem_url);
    const imageCandidates = [...(imageURL ? [imageURL] : []), ...localImageCandidates(product.nome)];
    const image = imageCandidates.length
        ? `<img src="${escapeHTML(imageCandidates[0])}" data-fallbacks="${escapeHTML(JSON.stringify(imageCandidates.slice(1)))}" onerror="window.tryNextProductImage(this)" alt="${escapeHTML(product.nome)}" loading="lazy">`
        : `<div class="product-placeholder">${CATEGORY_EMOJI[product.categoria] || '🛍️'}</div>`;
    const sizeInput = sizes.length ? `<label class="product-size-label" for="size-${escapeHTML(id)}">Tamanho</label><select class="product-size" id="size-${escapeHTML(id)}"><option value="">Selecione o tamanho</option>${sizes.map(size => `<option value="${escapeHTML(size.tamanho)}" ${Number(size.estoque) > 0 ? '' : 'disabled'}>${escapeHTML(size.tamanho)}${Number(size.estoque) > 0 ? '' : ' — esgotado'}</option>`).join('')}</select>` : '';
    return `<article class="product" data-category="${escapeHTML(product.categoria)}" data-name="${escapeHTML(product.nome)}">
        <div class="product-image">${image}${product.badge ? `<span class="badge">${escapeHTML(product.badge)}</span>` : ''}<button class="favorite" type="button" aria-label="Favoritar produto" onclick="favorite(this)">♡</button></div>
        <div class="product-info"><span class="product-category">${escapeHTML(product.categoria)}</span><h3>${escapeHTML(product.nome)}</h3><div class="rating">★★★★★</div><div class="price">${money(product.preco)} ${product.preco_antigo ? `<span class="old-price">${money(product.preco_antigo)}</span>` : ''}</div>${sizeInput}
        <button class="add-cart" type="button" data-id="${escapeHTML(id)}" onclick="addToCart(this.dataset.id)" ${available ? '' : 'disabled'}>${available ? 'Adicionar ao carrinho' : 'Esgotado'}</button></div></article>`;
}
function addToCart(id) {
    if (!JKAuth.customer || !productsById.has(id) || checkoutBusy) return;
    const sizes = sizesById.get(id) || [];
    const size = sizes.length ? $('size-' + id)?.value : null;
    if (sizes.length && !size) { alert('Selecione o tamanho do produto.'); return; }
    const existing = cart.find(item => item.produto_id === id && item.tamanho === size);
    const quantity = (existing?.quantidade || 0) + 1;
    if (quantity > 99 || quantity > availableStock(id, size)) { alert('Quantidade indisponível neste tamanho.'); return; }
    if (existing) existing.quantidade = quantity;
    else cart.push({produto_id: id, tamanho: size, quantidade: 1});
    pendingOrderKey = null;
    saveCart(); updateCart(); openCart();
}
function updateCart() {
    let quantity = 0;
    let total = 0;
    $('cartItems').innerHTML = cart.map((item, index) => {
        const product = productsById.get(item.produto_id);
        if (!product) return '';
        total += Number(product.preco) * item.quantidade;
        quantity += item.quantidade;
        return `<div class="cart-item"><div class="cart-item-image">${CATEGORY_EMOJI[product.categoria] || '🛍️'}</div><div class="cart-item-info"><h4>${escapeHTML(product.nome)}</h4><p>${item.tamanho ? 'Tamanho ' + escapeHTML(item.tamanho) + ' · ' : ''}${item.quantidade}x ${money(product.preco)}</p></div><button class="remove-item" type="button" aria-label="Remover ${escapeHTML(product.nome)}" onclick="removeItem(${index})" ${checkoutBusy ? 'disabled' : ''}>✕</button></div>`;
    }).join('') || '<p class="checkout-note">Seu carrinho está vazio.</p>';
    $('cart-count').textContent = quantity;
    $('cartTotal').textContent = money(total);
    $('checkoutButton').disabled = checkoutBusy || cart.length === 0;
}
function removeItem(index) {
    if (checkoutBusy) return;
    cart.splice(index, 1); pendingOrderKey = null; saveCart(); updateCart();
}
function openCart() { if (!JKAuth.customer) return; $('cartOverlay').classList.add('active'); document.body.style.overflow = 'hidden'; }
function closeCart() { $('cartOverlay').classList.remove('active'); document.body.style.overflow = ''; }
function closeCartOutside(event) { if (event.target.id === 'cartOverlay') closeCart(); }
async function checkoutPix() {
    if (!cart.length || checkoutBusy) return;
    try { await JKAuth.requireCustomer(); } catch { return; }
    if (!cart.length) return;
    closeCart();
    $('addressForm').hidden = false;
    $('orderSuccess').hidden = true;
    $('checkoutMessage').textContent = '';
    $('addressDialog').showModal();
}
function whatsappURL(order) { return 'https://wa.me/5561992227501?text=' + encodeURIComponent(JKUtils.whatsappMessage(order)); }
async function submitOrder(event) {
    event.preventDefault();
    if (checkoutBusy || !cart.length) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    let address;
    try { address = JKUtils.validateAddress(Object.fromEntries(new FormData(form))); }
    catch (error) { $('checkoutMessage').textContent = error.message; return; }
    checkoutBusy = true; updateCart();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    button.textContent = 'Registrando…';
    const owner = JKAuth.customer?.id;
    try {
        const customer = await JKAuth.requireCustomer();
        if (owner !== customer.id) throw new Error('Sessão alterada');
        const items = cart.map(item => ({...item}));
        // Only a hash and random request ID are persisted; no CPF or address in storage.
        const bytes = new TextEncoder().encode(JSON.stringify({items, address}));
        const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
        const keyName = 'jk_pending:' + owner;
        const saved = readStorage(keyName, null);
        if (!pendingOrderKey || pendingOrderKey.fingerprint !== fingerprint) pendingOrderKey = saved?.fingerprint === fingerprint ? saved : {fingerprint, id: crypto.randomUUID()};
        writeStorage(keyName, pendingOrderKey);
        const {data: order, error} = await supabaseClient.rpc('jk_criar_pedido', {p_itens: items, p_endereco: address, p_idempotencia: pendingOrderKey.id});
        if (JKAuth.customer?.id !== owner) return;
        if (error) {
            if (error.code === 'P0001') {
                const known = String(error.message || '');
                if (/estoque|tamanho|produto|quantidade/i.test(known)) throw new Error('Algum produto ou tamanho não está mais disponível. Atualize o carrinho e tente novamente.');
            }
            throw new Error('Não foi possível salvar o pedido. Seu carrinho foi mantido. Tente novamente.');
        }
        if (!order?.id || !Array.isArray(order.itens)) throw new Error('Não foi possível confirmar o registro. Tente novamente.');
        $('orderSuccessText').textContent = `Pedido ${order.id}. Produtos: ${money(order.total)}. Pagamento por Pix após a definição do frete pela loja.`;
        $('orderPix').dataset.pagarPix = order.id;
        $('orderWhatsapp').href = whatsappURL(order);
        $('addressForm').hidden = true;
        $('orderSuccess').hidden = false;
        form.reset();
        cart = []; pendingOrderKey = null; saveCart();
        try { sessionStorage.removeItem(keyName); } catch { /* Sem persistência. */ }
    } catch (error) {
        if (JKAuth.customer?.id === owner) $('checkoutMessage').textContent = error.message || 'Não foi possível registrar o pedido. Tente novamente.';
    } finally { checkoutBusy = false; button.disabled = false; button.textContent = 'Registrar pedido'; updateCart(); }
}
async function showCustomerOrders() {
    const owner = JKAuth.customer?.id;
    if (!owner) return;
    $('customerOrders').textContent = 'Carregando seus pedidos…';
    $('ordersDialog').showModal();
    try {
        const {data, error} = await supabaseClient.from('jk_pedidos').select('id,itens,total,status,fiscal_status,criado_em').eq('cliente_id', owner).order('criado_em', {ascending: false}).limit(30);
        if (JKAuth.customer?.id !== owner) return;
        if (error) throw error;
        const orders = data || [];
        const pix = orders.length ? await supabaseClient.from('jk_pix_cobrancas')
            .select('pedido_id,status,total,frete,desconto').in('pedido_id', orders.map(order => order.id)) : {data: []};
        if (JKAuth.customer?.id !== owner) return;
        const payments = new Map((pix.data || []).map(payment => [payment.pedido_id, payment]));
        $('customerOrders').innerHTML = orders.map(order => {
            const payment = payments.get(order.id);
            const paymentText = pix.error ? 'Pagamento Pix temporariamente indisponível' : JKPix.label(payment?.status);
            return `<article class="order-card"><p class="order-id">Pedido ${escapeHTML(order.id)}</p><p>${new Date(order.criado_em).toLocaleDateString('pt-BR')} · ${order.status === 'confirmado' ? 'Venda confirmada pela loja' : 'Aguardando confirmação'}</p>${order.itens.map(item => `<p>${item.quantidade}x ${escapeHTML(item.nome)}${item.tamanho ? ' · ' + escapeHTML(item.tamanho) : ''}</p>`).join('')}<p>Produtos: ${money(order.total)}</p>${payment ? `<p>Frete: ${money(payment.frete)} · Desconto: ${money(payment.desconto)}</p><p><strong>Total do pedido: ${money(payment.total)}</strong></p>` : ''}<p>Pix: ${escapeHTML(paymentText)}</p><p>Nota fiscal: emissão ainda não configurada pela loja.</p>${order.status !== 'confirmado' || payment ? `<button class="btn" type="button" data-pagar-pix="${escapeHTML(order.id)}">${payment?.status === 'paga' ? 'Ver pagamento' : 'Ver pagamento Pix'}</button>` : ''}<a class="btn btn-outline" target="_blank" rel="noopener noreferrer" href="${escapeHTML(whatsappURL(order))}">Falar sobre este pedido</a></article>`;
        }).join('') || '<p>Você ainda não tem pedidos.</p>';
    } catch { if (JKAuth.customer?.id === owner) $('customerOrders').textContent = 'Não foi possível carregar seus pedidos. Feche esta janela e tente novamente.'; }
}
function favorite(button) { button.classList.toggle('active'); button.textContent = button.classList.contains('active') ? '♥' : '♡'; }
function filterCategory(category) {
    activeCategory = category;
    const categories = ['todos', 'botas', 'roupas', 'chapeus', 'acessorios'];
    document.querySelectorAll('.filter-btn').forEach((button, index) => button.classList.toggle('active', categories[index] === category));
    applyFilters(); $('produtos').scrollIntoView({behavior: 'smooth'});
}
function applyFilters() {
    const search = $('search').value.trim().toLocaleLowerCase('pt-BR');
    document.querySelectorAll('.product').forEach(product => { product.hidden = !(activeCategory === 'todos' || product.dataset.category === activeCategory) || !product.dataset.name.toLocaleLowerCase('pt-BR').includes(search); });
}
function searchProducts() { applyFilters(); }
function focusSearch() { $('produtos').scrollIntoView({behavior:'smooth'}); $('search').focus({preventScroll:true}); }
function toggleMobileMenu() {
    const nav = document.querySelector('#storefront nav');
    if (nav.style.display === 'flex') nav.removeAttribute('style');
    else Object.assign(nav.style, {display:'flex', position:'absolute', top:'100%', left:'0', width:'100%', padding:'25px', background:'#080808', flexDirection:'column', borderBottom:'1px solid #392b12'});
}
function clearCustomerState() {
    ++loadingRevision;
    if (activeCustomerId) { try { sessionStorage.removeItem(cartKey()); sessionStorage.removeItem('jk_pending:' + activeCustomerId); } catch { /* Storage unavailable. */ } }
    activeCustomerId = null; cart = []; productsById.clear(); sizesById.clear(); pendingOrderKey = null;
    $('productsGrid').textContent = ''; $('customerOrders').textContent = ''; $('orderSuccessText').textContent = ''; $('orderWhatsapp').removeAttribute('href');
    delete $('orderPix').dataset.pagarPix;
    $('addressForm').reset(); closeCart(); updateCart();
}
$('addressForm').addEventListener('submit', submitOrder);
$('customerOrdersButton').addEventListener('click', showCustomerOrders);
window.addEventListener('jk:pix-paid', () => { if ($('ordersDialog').open) showCustomerOrders(); });
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $(button.dataset.closeDialog).close()));
document.querySelector('#addressForm select[name="uf"]').insertAdjacentHTML('beforeend', JKUtils.states.map(state => `<option>${state}</option>`).join(''));
window.addEventListener('jk:locked', clearCustomerState);
window.addEventListener('jk:ready', event => { if (event.detail.changed || activeCustomerId !== JKAuth.customer?.id) loadProducts(); });
JKAuth.ready.then(() => { if (JKAuth.customer && activeCustomerId !== JKAuth.customer.id) loadProducts(); });
updateCart();

