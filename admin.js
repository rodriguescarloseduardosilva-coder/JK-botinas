/* =========================================================
   JK BOTINAS - PAINEL ADMINISTRATIVO
   ========================================================= */

// =========================================================
// LOGIN
// =========================================================

let adminAutorizado = false;
let verificacaoAdmin = 0;
let revisaoPedidos = 0;
let paginaPedidos = 0;
const PEDIDOS_POR_PAGINA = 20;
const pedidosEmConfirmacao = new Set();

function ocultarPainel() {
    adminAutorizado = false;
    revisaoPedidos++;
    document.getElementById("adminPanel").style.display = "none";
    document.getElementById("loginScreen").style.display = "flex";
    document.getElementById("listaPedidosAdmin").replaceChildren();
    document.getElementById("pedidosMensagem").textContent = "";
    document.getElementById("modalTamanhos")?.remove();
}

async function verificarAcessoAdmin(session) {
    const verificacao = ++verificacaoAdmin;
    ocultarPainel();
    if (!session) return false;

    try {
        // A autorização vem do servidor e de app_metadata, que clientes não podem editar.
        const { data, error } = await supabaseClient.rpc("jk_e_admin");
        if (verificacao !== verificacaoAdmin) return false;
        if (error || data !== true) {
            document.getElementById("loginError").textContent = error
                ? "Não foi possível verificar o acesso administrativo. Tente novamente."
                : "Esta conta não tem acesso administrativo. Entre com uma conta da loja.";
            return false;
        }
        adminAutorizado = true;
        document.getElementById("loginError").textContent = "";
        mostrarPainel();
        return true;
    } catch (error) {
        if (verificacao === verificacaoAdmin) {
            document.getElementById("loginError").textContent = "Não foi possível verificar o acesso administrativo. Tente novamente.";
        }
        return false;
    }
}

async function fazerLogin() {
    const email = document.getElementById("loginEmail").value.trim();
    const senha = document.getElementById("loginPassword").value;
    const erro = document.getElementById("loginError");

    erro.textContent = "";

    if (!email || !senha) {
        erro.textContent = "Digite seu e-mail e sua senha.";
        return;
    }

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: senha
        });

        if (error) {
            console.error("Erro no login:", error);
            erro.textContent = error.message || "E-mail ou senha incorretos.";
            return;
        }

        if (!data.session) {
            erro.textContent = "Login realizado, mas nenhuma sessão foi criada.";
            return;
        }

        document.getElementById("loginPassword").value = "";
        await verificarAcessoAdmin(data.session);

    } catch (err) {
        console.error("Erro inesperado no login:", err);
        erro.textContent = "Erro ao realizar login.";
    }
}


// =========================================================
// LOGOUT
// =========================================================

async function fazerLogout() {
    verificacaoAdmin++;
    ocultarPainel();
    try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw error;

        document.getElementById("loginEmail").value = "";
        document.getElementById("loginPassword").value = "";

    } catch (error) {
        document.getElementById("loginError").textContent = "Não foi possível encerrar a sessão. Tente sair novamente.";
    }
}


// =========================================================
// MOSTRAR PAINEL
// =========================================================

function mostrarPainel() {
    if (!adminAutorizado) return;
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("adminPanel").style.display = "block";

    carregarProdutosAdmin();
    carregarDashboardEstoque();
    carregarPedidosAdmin();

}


// =========================================================
// ESCAPAR HTML
// Evita problemas quando nome/categoria possuem caracteres especiais
// =========================================================

function escapeHtml(valor) {
    if (valor === null || valor === undefined) {
        return "";
    }

    return String(valor)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


// =========================================================
// FORMATAR PREÇO
// =========================================================

function formatarPreco(valor) {
    const numero = Number(valor);

    if (isNaN(numero)) {
        return "R$ 0,00";
    }

    return numero.toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
    });
}

// =========================================================
// PEDIDOS: DADOS SALVOS NO MOMENTO DA COMPRA
// =========================================================

function formatarDataPedido(valor) {
    const data = new Date(valor);
    return Number.isNaN(data.getTime()) ? "Data indisponível" : data.toLocaleString("pt-BR");
}

function montarPedidoAdmin(pedido) {
    const cliente = pedido.cliente || {};
    const endereco = pedido.endereco || {};
    const itens = Array.isArray(pedido.itens) ? pedido.itens : [];
    const aguardando = pedido.status === "aguardando_confirmacao";
    const status = aguardando ? "Aguardando confirmação" : pedido.status === "confirmado" ? "Venda confirmada" : "Status indisponível";
    const enderecoLinha = [endereco.logradouro, endereco.numero, endereco.complemento].filter(Boolean).join(", ");
    const cidadeLinha = [endereco.bairro, endereco.cidade, endereco.uf].filter(Boolean).join(" · ");
    return `
        <article class="pedido-card">
            <div class="pedido-resumo">
                <div>
                    <h3>${escapeHtml(cliente.nome || "Cliente")}</h3>
                    <p class="pedido-id">Pedido ${escapeHtml(pedido.id)}</p>
                    <p>${escapeHtml(formatarDataPedido(pedido.criado_em))}</p>
                </div>
                <div class="pedido-valor">
                    <strong>${formatarPreco(pedido.total)}</strong>
                    <span class="pedido-status ${aguardando ? "pedido-pendente" : "pedido-confirmado"}">${status}</span>
                </div>
            </div>
            <details class="pedido-detalhes">
                <summary>Ver dados do cliente e itens</summary>
                <div class="pedido-dados">
                    <div>
                        <h4>Cliente</h4>
                        <dl>
                            <dt>Nome</dt><dd>${escapeHtml(cliente.nome || "—")}</dd>
                            <dt>CPF</dt><dd>${escapeHtml(cliente.cpf || "—")}</dd>
                            <dt>E-mail</dt><dd>${escapeHtml(cliente.email || "—")}</dd>
                            <dt>Telefone</dt><dd>${escapeHtml(cliente.telefone || "—")}</dd>
                        </dl>
                    </div>
                    <div>
                        <h4>Endereço informado</h4>
                        <p>${escapeHtml(enderecoLinha || "—")}</p>
                        <p>${escapeHtml(cidadeLinha || "—")}</p>
                        <p>CEP: ${escapeHtml(endereco.cep || "—")}</p>
                    </div>
                </div>
                <div class="pedido-tabela-wrapper">
                    <table class="pedido-itens">
                        <caption>Itens do pedido</caption>
                        <thead><tr><th>Produto</th><th>Tamanho</th><th>Qtd.</th><th>Unitário</th><th>Subtotal</th></tr></thead>
                        <tbody>${itens.map(item => `<tr>
                            <td>${escapeHtml(item.nome)}</td>
                            <td>${escapeHtml(item.tamanho || "Único")}</td>
                            <td>${escapeHtml(item.quantidade)}</td>
                            <td>${formatarPreco(item.preco_unitario)}</td>
                            <td>${formatarPreco(item.subtotal)}</td>
                        </tr>`).join("")}</tbody>
                    </table>
                </div>
                <p class="pedido-fiscal">Consulte a emissão e a autorização no módulo de notas fiscais.</p>
                <p><a class="btn btn-outline" href="fiscal.html?pedido=${encodeURIComponent(pedido.id)}">Criar rascunho de nota com estes dados</a></p>
                ${pedido.confirmado_em ? `<p>Venda confirmada em ${escapeHtml(formatarDataPedido(pedido.confirmado_em))}.</p>` : ""}
            </details>
            ${aguardando ? `<div class="pedido-acoes">
                <p>Confirme somente após verificar a venda e o pagamento. O estoque será baixado.</p>
                <button class="btn" type="button" data-confirmar-pedido="${escapeHtml(pedido.id)}">Confirmar venda</button>
            </div>` : ""}
        </article>`;
}

async function carregarPedidosAdmin() {
    if (!adminAutorizado) return;
    const revisao = ++revisaoPedidos;
    const lista = document.getElementById("listaPedidosAdmin");
    const mensagem = document.getElementById("pedidosMensagem");
    const anterior = document.getElementById("pedidosAnterior");
    const proxima = document.getElementById("pedidosProxima");
    mensagem.textContent = "Carregando pedidos…";
    lista.replaceChildren();
    anterior.disabled = true;
    proxima.disabled = true;
    try {
        let consulta = supabaseClient.from("jk_pedidos")
            .select("id,cliente,endereco,itens,total,status,fiscal_status,criado_em,confirmado_em", { count: "exact" })
            .order("criado_em", { ascending: false })
            .order("id", { ascending: false });
        const filtro = document.getElementById("filtroPedidos").value;
        if (filtro) consulta = consulta.eq("status", filtro);
        const { data, count, error } = await consulta.range(paginaPedidos * PEDIDOS_POR_PAGINA, (paginaPedidos + 1) * PEDIDOS_POR_PAGINA - 1);
        if (!adminAutorizado || revisao !== revisaoPedidos) return;
        if (error) throw error;
        const pedidos = data || [];
        if (!pedidos.length && paginaPedidos > 0) {
            paginaPedidos--;
            return carregarPedidosAdmin();
        }
        lista.innerHTML = pedidos.map(montarPedidoAdmin).join("");
        lista.querySelectorAll("[data-confirmar-pedido]").forEach(botao => {
            botao.disabled = pedidosEmConfirmacao.has(botao.dataset.confirmarPedido);
            botao.addEventListener("click", () => confirmarPedidoAdmin(botao.dataset.confirmarPedido, botao));
        });
        mensagem.textContent = pedidos.length ? `${count ?? pedidos.length} pedido(s) encontrado(s).` : "Nenhum pedido encontrado.";
        document.getElementById("pedidosPagina").textContent = `Página ${paginaPedidos + 1}`;
        anterior.disabled = paginaPedidos === 0;
        proxima.disabled = (paginaPedidos + 1) * PEDIDOS_POR_PAGINA >= (count ?? pedidos.length);
    } catch (error) {
        if (!adminAutorizado || revisao !== revisaoPedidos) return;
        mensagem.textContent = "Não foi possível carregar os pedidos. Verifique a conexão e a configuração do banco de dados.";
    }
}

function mudarPaginaPedidos(direcao) {
    if (!adminAutorizado) return;
    paginaPedidos = Math.max(0, paginaPedidos + direcao);
    carregarPedidosAdmin();
}

async function confirmarPedidoAdmin(id, botao) {
    if (!adminAutorizado || pedidosEmConfirmacao.has(id)) return;
    if (!confirm("A venda e o pagamento deste pedido já foram conferidos? Ao confirmar, o estoque será baixado. Esta ação não realiza cobrança nem emite nota fiscal.")) return;
    const verificacao = verificacaoAdmin;
    pedidosEmConfirmacao.add(id);
    botao.disabled = true;
    botao.textContent = "Confirmando…";
    const mensagem = document.getElementById("pedidosMensagem");
    try {
        const { data, error } = await supabaseClient.rpc("jk_confirmar_pedido", { p_pedido_id: id });
        if (!adminAutorizado || verificacao !== verificacaoAdmin) return;
        if (error) throw error;
        if (!data || data.status !== "confirmado") throw new Error("Confirmação não retornou um pedido confirmado.");
        await carregarPedidosAdmin();
        if (!adminAutorizado || verificacao !== verificacaoAdmin) return;
        mensagem.textContent = "Venda confirmada e estoque atualizado. Para emitir a nota, abra o módulo de notas fiscais.";
        carregarProdutosAdmin();
        carregarDashboardEstoque();
    } catch (error) {
        if (adminAutorizado && verificacao === verificacaoAdmin) {
            mensagem.textContent = "Não foi possível confirmar a venda. Atualize os pedidos e verifique o estoque antes de tentar novamente.";
        }
    } finally {
        pedidosEmConfirmacao.delete(id);
        botao.disabled = false;
        botao.textContent = "Confirmar venda";
    }
}


// =========================================================
// PEGAR URL PÚBLICA DE UMA IMAGEM
// =========================================================

function obterUrlImagem(caminho) {

    if (!caminho) {
        return null;
    }

    // Se já for uma URL completa, não modifica
    if (
        caminho.startsWith("http://") ||
        caminho.startsWith("https://")
    ) {
        return caminho;
    }

    const { data } = supabaseClient.storage
        .from("produtos")
        .getPublicUrl(caminho);

    return data?.publicUrl || null;
}


// =========================================================
// CARREGAR IMAGENS DOS PRODUTOS
// =========================================================

async function carregarImagensProdutos() {

    const { data, error } = await supabaseClient
        .from("produto_imagens")
        .select("produto_id, url, ordem")
        .order("ordem", { ascending: true });

    if (error) {
        console.error("Erro ao carregar imagens:", error);
        return {};
    }

    const imagensPorProduto = {};

    (data || []).forEach(imagem => {

        if (!imagensPorProduto[imagem.produto_id]) {
            imagensPorProduto[imagem.produto_id] = [];
        }

        const urlPublica = obterUrlImagem(imagem.url);

        if (urlPublica) {
            imagensPorProduto[imagem.produto_id].push({
                url: urlPublica,
                caminho: imagem.url,
                ordem: imagem.ordem
            });
        }
    });

    return imagensPorProduto;
}

// =========================================================
// CARREGAR PRODUTOS NO PAINEL
// =========================================================

async function carregarProdutosAdmin() {

    const tbody = document.getElementById("adminTableBody");

    if (!tbody) {
        console.error("Elemento adminTableBody não encontrado.");
        return;
    }

    tbody.innerHTML = `
        <tr>
            <td colspan="7">Carregando produtos...</td>
        </tr>
    `;

    try {

        // -----------------------------------------
        // BUSCAR PRODUTOS
        // -----------------------------------------

        const {
            data: produtos,
            error: erroProdutos
        } = await supabaseClient
            .from("produtos")
            .select("*")
            .order("criado_em", {
                ascending: false
            });

        if (erroProdutos) {

            console.error(
                "Erro ao carregar produtos:",
                erroProdutos
            );

            tbody.innerHTML = `
                <tr>
                    <td colspan="7">
                        Erro ao carregar produtos:
                        ${escapeHtml(erroProdutos.message)}
                    </td>
                </tr>
            `;

            return;
        }


        // -----------------------------------------
        // BUSCAR IMAGENS
        // -----------------------------------------

        const imagensPorProduto =
            await carregarImagensProdutos();


        // -----------------------------------------
        // NENHUM PRODUTO
        // -----------------------------------------

        if (!produtos || produtos.length === 0) {

            tbody.innerHTML = `
                <tr>
                    <td colspan="7">
                        Nenhum produto cadastrado.
                    </td>
                </tr>
            `;

            return;
        }


        // -----------------------------------------
        // MONTAR TABELA
        // -----------------------------------------

        tbody.innerHTML = produtos.map(produto => {

            let imagemUrl = null;

            // Primeiro tenta produto_imagens
            if (
                imagensPorProduto[produto.id] &&
                imagensPorProduto[produto.id].length > 0
            ) {

                imagemUrl =
                    imagensPorProduto[produto.id][0].url;
            }


            // Se não encontrou, usa imagem_url
            if (
                !imagemUrl &&
                produto.imagem_url
            ) {

                imagemUrl =
                    obterUrlImagem(
                        produto.imagem_url
                    );
            }


            // -----------------------------------------
            // IMAGEM
            // -----------------------------------------

            const imagemHTML = imagemUrl

                ? `
                    <div class="admin-product-image">

                        <img
                            src="${escapeHtml(imagemUrl)}"
                            alt="${escapeHtml(produto.nome)}"
                            loading="lazy"
                            onerror="
                                this.style.display='none';
                                this.nextElementSibling.style.display='flex';
                            "
                        >

                        <div
                            class="admin-image-error"
                            style="display:none;"
                        >
                            Sem imagem
                        </div>

                    </div>
                `

                : `
                    <div class="admin-product-image admin-no-image">
                        Sem imagem
                    </div>
                `;


            // -----------------------------------------
            // LINHA DO PRODUTO
            // -----------------------------------------

            return `
                <tr>

                    <!-- IMAGEM -->
                    <td>
                        ${imagemHTML}
                    </td>


                    <!-- PRODUTO -->
                    <td>
                        <strong>
                            ${escapeHtml(produto.nome)}
                        </strong>
                    </td>


                    <!-- CATEGORIA -->
                    <td>
                        ${escapeHtml(
                            produto.categoria || "-"
                        )}
                    </td>


                    <!-- PREÇO -->
                    <td>
                        ${formatarPreco(produto.preco)}
                    </td>


                    <!-- ESTOQUE -->
                    <td>

                        <input
                            type="number"
                            min="0"
                            value="${Number(
                                produto.estoque || 0
                            )}"
                            id="estoque-${produto.id}"
                            class="estoque-input"
                        >

                    </td>


                    <!-- SALVAR ESTOQUE -->
                    <td>

                        <button
                            class="btn"
                            onclick="salvarEstoque('${produto.id}')"
                        >
                            Salvar
                        </button>

                    </td>


                    <!-- AÇÕES -->
                    <td>

<div class="admin-actions">

    <button
        class="btn-tamanhos"
        onclick="abrirTamanhos('${produto.id}')"
    >
        📏 Tamanhos
    </button>

    <button
        class="btn-edit"
        onclick="editarProduto('${produto.id}')"
    >
        ✏️ Editar
    </button>

    <button
        class="btn-delete"
        onclick="excluirProduto('${produto.id}')"
    >
        🗑️ Excluir
    </button>

</div>

                    </td>

                </tr>
            `;

        }).join("");


    } catch (error) {

        console.error(
            "Erro inesperado:",
            error
        );

        tbody.innerHTML = `
            <tr>
                <td colspan="7">
                    Ocorreu um erro ao carregar os produtos.
                </td>
            </tr>
        `;
    }
}

// =========================================================
// GERENCIAR TAMANHOS DO PRODUTO
// =========================================================

async function abrirTamanhos(id) {

    try {

        const {
            data: produto,
            error: erroProduto
        } = await supabaseClient
            .from("produtos")
            .select("id, nome")
            .eq("id", id)
            .single();

        if (erroProduto || !produto) {
            alert("Produto não encontrado.");
            return;
        }

        const {
            data: tamanhos,
            error: erroTamanhos
        } = await supabaseClient
            .from("produto_tamanhos")
            .select("*")
            .eq("produto_id", id)
            .order("id", { ascending: true });

        if (erroTamanhos) {
            console.error(erroTamanhos);
            alert("Erro ao carregar os tamanhos.");
            return;
        }

        let linhas = "";

        if (tamanhos && tamanhos.length > 0) {

            linhas = tamanhos.map(tamanho => `
                <div class="tamanho-linha">

                    <input
                        type="text"
                        class="tamanho-nome"
                        value="${escapeHtml(tamanho.tamanho)}"
                        placeholder="Tamanho"
                    >

                    <input
                        type="number"
                        min="0"
                        class="tamanho-estoque"
                        value="${Number(tamanho.estoque || 0)}"
                        placeholder="Estoque"
                    >

                    <button
                        type="button"
                        class="btn-delete-tamanho"
                        onclick="this.parentElement.remove()"
                    >
                        🗑️
                    </button>

                </div>
            `).join("");

        }

        const modal = document.createElement("div");

        modal.id = "modalTamanhos";

        modal.innerHTML = `

            <div class="modal-tamanhos-overlay">

                <div class="modal-tamanhos">

                    <div class="modal-tamanhos-header">

                        <h2>
                            Tamanhos
                        </h2>

                        <button
                            type="button"
                            class="modal-fechar"
                            onclick="fecharModalTamanhos()"
                        >
                            ✕
                        </button>

                    </div>

                    <p class="modal-produto-nome">
                        ${escapeHtml(produto.nome)}
                    </p>

                    <div class="tamanhos-cabecalho">

                        <span>Tamanho</span>
                        <span>Estoque</span>
                        <span></span>

                    </div>

                    <div
                        id="listaTamanhos"
                        class="lista-tamanhos"
                    >
                        ${linhas}
                    </div>

                    <button
                        type="button"
                        class="btn-adicionar-tamanho"
                        onclick="adicionarLinhaTamanho()"
                    >
                        + Adicionar tamanho
                    </button>

                    <div class="modal-tamanhos-acoes">

                        <button
                            type="button"
                            class="btn-cancelar-tamanhos"
                            onclick="fecharModalTamanhos()"
                        >
                            Cancelar
                        </button>

                        <button
                            type="button"
                            class="btn-salvar-tamanhos"
                            onclick="salvarTamanhos('${id}')"
                        >
                            💾 Salvar tamanhos
                        </button>

                    </div>

                </div>

            </div>

        `;

        document.body.appendChild(modal);

    } catch (error) {

        console.error(
            "Erro ao abrir tamanhos:",
            error
        );

        alert("Erro ao abrir os tamanhos.");

    }

}


// =========================================================
// ADICIONAR LINHA DE TAMANHO
// =========================================================

function adicionarLinhaTamanho() {

    const lista =
        document.getElementById("listaTamanhos");

    if (!lista) {
        return;
    }

    const linha =
        document.createElement("div");

    linha.className =
        "tamanho-linha";

    linha.innerHTML = `

        <input
            type="text"
            class="tamanho-nome"
            placeholder="Ex: M ou 40"
        >

        <input
            type="number"
            min="0"
            class="tamanho-estoque"
            value="0"
            placeholder="Estoque"
        >

        <button
            type="button"
            class="btn-delete-tamanho"
            onclick="this.parentElement.remove()"
        >
            🗑️
        </button>

    `;

    lista.appendChild(linha);

}


// =========================================================
// SALVAR TAMANHOS
// =========================================================

async function salvarTamanhos(id) {

    const lista =
        document.getElementById("listaTamanhos");

    if (!lista) {
        return;
    }

    const linhas =
        lista.querySelectorAll(".tamanho-linha");

    const tamanhos = [];

    for (const linha of linhas) {

        const nomeInput =
            linha.querySelector(".tamanho-nome");

        const estoqueInput =
            linha.querySelector(".tamanho-estoque");

        const tamanho =
            nomeInput.value.trim();

        const estoque =
            Number(estoqueInput.value);

        if (!tamanho) {
            alert("Preencha todos os tamanhos.");
            return;
        }

        if (
            isNaN(estoque) ||
            estoque < 0
        ) {
            alert(
                `Estoque inválido para o tamanho ${tamanho}.`
            );
            return;
        }

        tamanhos.push({
            produto_id: id,
            tamanho: tamanho,
            estoque: estoque
        });

    }

    // Impedir tamanhos duplicados
    const nomes =
        tamanhos.map(item =>
            item.tamanho.toLowerCase()
        );

    const nomesUnicos =
        new Set(nomes);

    if (
        nomes.length !== nomesUnicos.size
    ) {
        alert(
            "Você não pode cadastrar o mesmo tamanho duas vezes."
        );
        return;
    }

    try {

        // Apagar os tamanhos antigos
        const {
            error: erroDelete
        } = await supabaseClient
            .from("produto_tamanhos")
            .delete()
            .eq("produto_id", id);

        if (erroDelete) {

            console.error(
                "Erro ao apagar tamanhos antigos:",
                erroDelete
            );

            alert(
                "Erro ao atualizar os tamanhos."
            );

            return;
        }

        // Se não houver tamanhos,
        // apenas salva a lista vazia
        if (tamanhos.length > 0) {

            const {
                error: erroInsert
            } = await supabaseClient
                .from("produto_tamanhos")
                .insert(tamanhos);

            if (erroInsert) {

                console.error(
                    "Erro ao salvar tamanhos:",
                    erroInsert
                );

                alert(
                    "Erro ao salvar os tamanhos."
                );

                return;
            }

        }

        alert(
            "Tamanhos e estoques salvos com sucesso!"
        );

        fecharModalTamanhos();

        await carregarProdutosAdmin();

    } catch (error) {

        console.error(
            "Erro inesperado ao salvar tamanhos:",
            error
        );

        alert(
            "Ocorreu um erro inesperado."
        );

    }

}


// =========================================================
// FECHAR MODAL DE TAMANHOS
// =========================================================

function fecharModalTamanhos() {

    const modal =
        document.getElementById("modalTamanhos");

    if (modal) {
        modal.remove();
    }

}

// =========================================================
// SALVAR ESTOQUE
// =========================================================

async function salvarEstoque(id) {


    const input = document.getElementById(`estoque-${id}`);

    if (!input) {
        alert("Campo de estoque não encontrado.");
        return;
    }

    const estoque = Number(input.value);

    if (estoque < 0 || isNaN(estoque)) {
        alert("Digite um estoque válido.");
        return;
    }

    try {

        const { error } = await supabaseClient
            .from("produtos")
            .update({
                estoque: estoque
            })
            .eq("id", id);

        if (error) {
            console.error("Erro ao salvar estoque:", error);
            alert("Erro ao salvar estoque.");
            return;
        }

        alert("Estoque atualizado com sucesso!");

    } catch (error) {

        console.error(error);
        alert("Erro inesperado ao salvar estoque.");
    }
    // ATUALIZA O DASHBOARD
    carregarDashboardEstoque();
}
// =========================================================
// EXCLUIR PRODUTO
// =========================================================

async function excluirProduto(id) {

    const confirmar = confirm(
        "ATENÇÃO!\n\n" +
        "Você realmente deseja excluir este produto?\n\n" +
        "Essa ação não poderá ser desfeita."
    );

    if (!confirmar) {
        return;
    }

    try {

        // Verificar se está logado
        const {
            data: { session }
        } = await supabaseClient.auth.getSession();

        if (!session) {
            alert("Sua sessão expirou. Faça login novamente.");
            return;
        }


        // Buscar o produto
        const {
            data: produto,
            error: erroProduto
        } = await supabaseClient
            .from("produtos")
            .select("id, nome")
            .eq("id", id)
            .single();


        if (erroProduto || !produto) {

            console.error(erroProduto);

            alert("Produto não encontrado.");

            return;
        }


        // Buscar imagens relacionadas
        const {
            data: imagens,
            error: erroImagens
        } = await supabaseClient
            .from("produto_imagens")
            .select("url")
            .eq("produto_id", id);


        if (erroImagens) {

            console.error(erroImagens);

            alert(
                "Erro ao localizar as imagens do produto."
            );

            return;
        }


        // Excluir arquivos do Storage
        if (imagens && imagens.length > 0) {

            const caminhos = imagens
                .map(imagem => imagem.url)
                .filter(url => url);


            if (caminhos.length > 0) {

                const {
                    error: erroStorage
                } = await supabaseClient
                    .storage
                    .from("produtos")
                    .remove(caminhos);


                if (erroStorage) {

                    console.error(
                        "Erro ao excluir imagem:",
                        erroStorage
                    );

                    alert(
                        "Não foi possível excluir as imagens do produto."
                    );

                    return;
                }
            }
        }


        // Excluir registros da tabela produto_imagens
        const {
            error: erroImagensDelete
        } = await supabaseClient
            .from("produto_imagens")
            .delete()
            .eq("produto_id", id);


        if (erroImagensDelete) {

            console.error(
                "Erro ao excluir registros das imagens:",
                erroImagensDelete
            );

            alert(
                "Erro ao excluir as imagens relacionadas ao produto."
            );

            return;
        }


        // Excluir produto
        const {
            error: erroDelete
        } = await supabaseClient
            .from("produtos")
            .delete()
            .eq("id", id);


        if (erroDelete) {

            console.error(
                "Erro ao excluir produto:",
                erroDelete
            );

            alert(
                "Erro ao excluir o produto:\n\n" +
                erroDelete.message
            );

            return;
        }


        // Sucesso
        alert(
            `Produto "${produto.nome}" excluído com sucesso!`
        );


        // Atualizar tabela
        await carregarProdutosAdmin();


    } catch (error) {

        console.error(
            "Erro inesperado ao excluir produto:",
            error
        );

        alert(
            "Ocorreu um erro inesperado ao excluir o produto."
        );
    }
}
// =========================================================
// EDITAR PRODUTO
// =========================================================

async function editarProduto(id) {

    try {

        // -----------------------------------------
        // BUSCAR PRODUTO
        // -----------------------------------------

        const {
            data: produto,
            error
        } = await supabaseClient
            .from("produtos")
            .select("*")
            .eq("id", id)
            .single();


        if (error || !produto) {

            console.error(
                "Erro ao buscar produto:",
                error
            );

            alert("Não foi possível encontrar o produto.");

            return;
        }


        // -----------------------------------------
        // NOVO NOME
        // -----------------------------------------

        const novoNome = prompt(
            "Nome do produto:",
            produto.nome || ""
        );

        if (novoNome === null) {
            return;
        }


        if (!novoNome.trim()) {

            alert(
                "O nome do produto não pode ficar vazio."
            );

            return;
        }


        // -----------------------------------------
        // NOVA CATEGORIA
        // -----------------------------------------

        const novaCategoria = prompt(
            "Categoria do produto:",
            produto.categoria || ""
        );

        if (novaCategoria === null) {
            return;
        }


        if (!novaCategoria.trim()) {

            alert(
                "A categoria não pode ficar vazia."
            );

            return;
        }


        // -----------------------------------------
        // NOVO PREÇO
        // -----------------------------------------

        const novoPrecoTexto = prompt(
            "Preço do produto:",
            Number(produto.preco || 0)
                .toFixed(2)
                .replace(".", ",")
        );

        if (novoPrecoTexto === null) {
            return;
        }


        const novoPreco = Number(
            novoPrecoTexto
                .replace(",", ".")
        );


        if (
            isNaN(novoPreco) ||
            novoPreco < 0
        ) {

            alert(
                "Digite um preço válido."
            );

            return;
        }


        // -----------------------------------------
        // NOVO ESTOQUE
        // -----------------------------------------

        const novoEstoqueTexto = prompt(
            "Quantidade em estoque:",
            Number(produto.estoque || 0)
        );

        if (novoEstoqueTexto === null) {
            return;
        }


        const novoEstoque =
            Number(novoEstoqueTexto);


        if (
            isNaN(novoEstoque) ||
            novoEstoque < 0
        ) {

            alert(
                "Digite um estoque válido."
            );

            return;
        }


        // -----------------------------------------
        // CONFIRMAR
        // -----------------------------------------

        const confirmar = confirm(
            "Deseja salvar as alterações deste produto?"
        );

        if (!confirmar) {
            return;
        }


        // -----------------------------------------
        // ATUALIZAR NO SUPABASE
        // -----------------------------------------

        const {
            error: erroAtualizacao
        } = await supabaseClient
            .from("produtos")
            .update({

                nome: novoNome.trim(),

                categoria:
                    novaCategoria.trim(),

                preco:
                    novoPreco,

                estoque:
                    novoEstoque

            })
            .eq("id", id);


        if (erroAtualizacao) {

            console.error(
                "Erro ao editar produto:",
                erroAtualizacao
            );

            alert(
                "Erro ao salvar as alterações."
            );

            return;
        }


        // -----------------------------------------
        // SUCESSO
        // -----------------------------------------

        alert(
            "Produto atualizado com sucesso!"
        );


        await carregarProdutosAdmin();

        // Calcular o estoque total somando todos os tamanhos
const estoqueTotal = tamanhos.reduce(
    (total, item) => total + Number(item.estoque),
    0
);

// Atualizar o estoque total na tabela produtos
const {
    error: erroEstoque
} = await supabaseClient
    .from("produtos")
    .update({
        estoque: estoqueTotal
    })
    .eq("id", id);

if (erroEstoque) {

    console.error(
        "Erro ao atualizar estoque total:",
        erroEstoque
    );

    alert(
        "Os tamanhos foram salvos, mas houve erro ao atualizar o estoque total."
    );

    return;
}

alert(
    "Tamanhos e estoques salvos com sucesso!"
);

fecharModalTamanhos();

await carregarProdutosAdmin();

await carregarDashboardEstoque();


    } catch (error) {

        console.error(
            "Erro inesperado ao editar:",
            error
        );

        alert(
            "Ocorreu um erro inesperado."
        );
    }
}



// =========================================================
// EXCLUIR PRODUTO
// =========================================================

async function excluirProduto(id) {

    try {

        // -----------------------------------------
        // BUSCAR PRODUTO
        // -----------------------------------------

        const {
            data: produto,
            error: erroProduto
        } = await supabaseClient
            .from("produtos")
            .select("id, nome")
            .eq("id", id)
            .single();


        if (
            erroProduto ||
            !produto
        ) {

            console.error(
                "Erro ao encontrar produto:",
                erroProduto
            );

            alert(
                "Produto não encontrado."
            );

            return;
        }


        // -----------------------------------------
        // CONFIRMAR EXCLUSÃO
        // -----------------------------------------

        const confirmar = confirm(
            `ATENÇÃO!\n\n` +
            `Você está prestes a excluir:\n\n` +
            `"${produto.nome}"\n\n` +
            `Essa ação não poderá ser desfeita.\n\n` +
            `Deseja realmente excluir?`
        );


        if (!confirmar) {
            return;
        }


        // -----------------------------------------
        // BUSCAR IMAGENS
        // -----------------------------------------

        const {
            data: imagens,
            error: erroImagens
        } = await supabaseClient
            .from("produto_imagens")
            .select("url")
            .eq("produto_id", id);


        if (erroImagens) {

            console.error(
                "Erro ao buscar imagens:",
                erroImagens
            );

            alert(
                "Não foi possível preparar a exclusão."
            );

            return;
        }


        // -----------------------------------------
        // EXCLUIR ARQUIVOS DO STORAGE
        // -----------------------------------------

        if (
            imagens &&
            imagens.length > 0
        ) {

            const caminhos = imagens
                .map(imagem => imagem.url)
                .filter(Boolean);


            if (caminhos.length > 0) {

                const {
                    error: erroStorage
                } = await supabaseClient
                    .storage
                    .from("produtos")
                    .remove(caminhos);


                if (erroStorage) {

                    console.error(
                        "Erro ao excluir imagens:",
                        erroStorage
                    );

                    alert(
                        "Não foi possível excluir as imagens do produto."
                    );

                    return;
                }
            }
        }


        // -----------------------------------------
        // EXCLUIR REGISTROS DAS IMAGENS
        // -----------------------------------------

        const {
            error: erroImagensDelete
        } = await supabaseClient
            .from("produto_imagens")
            .delete()
            .eq("produto_id", id);


        if (erroImagensDelete) {

            console.error(
                "Erro ao excluir registros das imagens:",
                erroImagensDelete
            );

            alert(
                "Erro ao excluir as imagens do produto."
            );

            return;
        }


        // -----------------------------------------
        // EXCLUIR PRODUTO
        // -----------------------------------------

        const {
            error: erroDelete
        } = await supabaseClient
            .from("produtos")
            .delete()
            .eq("id", id);


        if (erroDelete) {

            console.error(
                "Erro ao excluir produto:",
                erroDelete
            );

            alert(
                "Erro ao excluir o produto."
            );

            return;
        }


        // -----------------------------------------
        // SUCESSO
        // -----------------------------------------

        alert(
            "Produto excluído com sucesso!"
        );


        await carregarProdutosAdmin();


    } catch (error) {

        console.error(
            "Erro inesperado ao excluir:",
            error
        );

        alert(
            "Ocorreu um erro inesperado."
        );
    }
}


// =========================================================
// GERAR NOME SEGURO PARA A IMAGEM
// =========================================================

function gerarNomeArquivoSeguro(nomeOriginal) {

    const extensao =
        nomeOriginal.split(".").pop().toLowerCase();

    const nomeSemExtensao =
        nomeOriginal
            .replace(/\.[^/.]+$/, "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-zA-Z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase();

    const identificador =
        Date.now() + "-" + Math.random().toString(36).substring(2, 8);

    return `${nomeSemExtensao}-${identificador}.${extensao}`;
}
// =========================================================
// OPÇÕES DE TAMANHO PARA CADASTRO
// =========================================================

const TAMANHOS_POR_CATEGORIA = {

    roupas: [
        "PP",
        "P",
        "M",
        "G",
        "GG",
        "XG"
    ],

    botas: [
        "34",
        "35",
        "36",
        "37",
        "38",
        "39",
        "40",
        "41",
        "42",
        "43",
        "44",
        "45"
    ],

    chapeus: [
        "54",
        "56",
        "58",
        "60",
        "62"
    ],

    acessorios: [
        "Único"
    ]

};


// =========================================================
// MOSTRAR TAMANHOS DE ACORDO COM A CATEGORIA
// =========================================================

function atualizarOpcoesTamanho() {

    const categoria =
        document.getElementById("novaCategoria").value;

    const area =
        document.getElementById("opcoesTamanhosCadastro");

    const total =
        document.getElementById("estoqueTotalCadastro");

    if (!area) {
        return;
    }

    if (!categoria) {

        area.innerHTML = `
            <p style="color:#888;">
                Selecione primeiro uma categoria.
            </p>
        `;

        if (total) {
            total.textContent =
                "Estoque total: 0";
        }

        return;
    }

    const tamanhos =
        TAMANHOS_POR_CATEGORIA[categoria] || [];

    area.innerHTML = tamanhos.map(tamanho => `

        <div
            class="cadastro-tamanho-item"
            style="
                display:flex;
                align-items:center;
                gap:10px;
                margin-bottom:8px;
            "
        >

            <label
                style="
                    display:flex;
                    align-items:center;
                    gap:8px;
                    width:80px;
                    color:#fff;
                    cursor:pointer;
                "
            >

                <input
                    type="checkbox"
                    class="tamanho-checkbox"
                    data-tamanho="${escapeHtml(tamanho)}"
                    onchange="atualizarEstoqueTotalCadastro()"
                >

                <strong>
                    ${escapeHtml(tamanho)}
                </strong>

            </label>

            <input
                type="number"
                min="0"
                value="0"
                class="cadastro-tamanho-estoque"
                data-tamanho-estoque="${escapeHtml(tamanho)}"
                disabled
                oninput="atualizarEstoqueTotalCadastro()"
                style="
                    width:120px;
                    padding:8px;
                    background:#111;
                    border:1px solid #333;
                    color:#fff;
                    border-radius:4px;
                "
            >

        </div>

    `).join("");

    // Ativar/desativar campo de estoque
    document
        .querySelectorAll(".tamanho-checkbox")
        .forEach(checkbox => {

            checkbox.addEventListener(
                "change",
                function () {

                    const tamanho =
                        this.dataset.tamanho;

                    const estoqueInput =
                        document.querySelector(
                            `[data-tamanho-estoque="${CSS.escape(tamanho)}"]`
                        );

                    if (estoqueInput) {

                        estoqueInput.disabled =
                            !this.checked;

                        if (!this.checked) {
                            estoqueInput.value = 0;
                        }

                    }

                    atualizarEstoqueTotalCadastro();

                }
            );

        });

    atualizarEstoqueTotalCadastro();
}


// =========================================================
// CALCULAR ESTOQUE TOTAL
// =========================================================

function atualizarEstoqueTotalCadastro() {

    const checkboxes =
        document.querySelectorAll(
            ".tamanho-checkbox:checked"
        );

    let total = 0;

    checkboxes.forEach(checkbox => {

        const tamanho =
            checkbox.dataset.tamanho;

        const input =
            document.querySelector(
                `[data-tamanho-estoque="${CSS.escape(tamanho)}"]`
            );

        if (input) {

            const quantidade =
                Number(input.value);

            if (!isNaN(quantidade)) {
                total += quantidade;
            }

        }

    });

    const elemento =
        document.getElementById(
            "estoqueTotalCadastro"
        );

    if (elemento) {

        elemento.textContent =
            `Estoque total: ${total}`;

    }

}


// =========================================================
// PEGAR TAMANHOS SELECIONADOS
// =========================================================

function obterTamanhosCadastro() {

    const checkboxes =
        document.querySelectorAll(
            ".tamanho-checkbox:checked"
        );

    const tamanhos = [];

    checkboxes.forEach(checkbox => {

        const tamanho =
            checkbox.dataset.tamanho;

        const input =
            document.querySelector(
                `[data-tamanho-estoque="${CSS.escape(tamanho)}"]`
            );

        const estoque =
            Number(input?.value || 0);

        tamanhos.push({
            tamanho: tamanho,
            estoque: estoque
        });

    });

    return tamanhos;
}

// =========================================================
// CADASTRAR NOVO PRODUTO
// =========================================================

async function cadastrarProduto(event) {
    event.preventDefault();

    const msg = document.getElementById("msgCadastro");

    const nome = document.getElementById("novoNome").value.trim();
    const categoria = document.getElementById("novaCategoria").value;
    const preco = Number(document.getElementById("novoPreco").value);
    const imagemInput = document.getElementById("novaImagem");

    // ================================
    // TAMANHOS E ESTOQUE
    // ================================

    const tamanhosSelecionados = obterTamanhosCadastro();

    let estoque = 0;

    tamanhosSelecionados.forEach(item => {
        estoque += Number(item.estoque || 0);
    });

    // ================================
    // VALIDAÇÕES
    // ================================

    if (!nome) {
        msg.textContent = "Digite o nome do produto.";
        msg.style.color = "#ff5555";
        return;
    }

    if (!categoria) {
        msg.textContent = "Selecione uma categoria.";
        msg.style.color = "#ff5555";
        return;
    }

    if (isNaN(preco) || preco < 0) {
        msg.textContent = "Digite um preço válido.";
        msg.style.color = "#ff5555";
        return;
    }

    if (tamanhosSelecionados.length === 0) {
        msg.textContent = "Selecione pelo menos um tamanho.";
        msg.style.color = "#ff5555";
        return;
    }

    for (const item of tamanhosSelecionados) {
        if (isNaN(item.estoque) || item.estoque < 0) {
            msg.textContent = `Digite um estoque válido para o tamanho ${item.tamanho}.`;
            msg.style.color = "#ff5555";
            return;
        }
    }

    if (!imagemInput || !imagemInput.files || !imagemInput.files[0]) {
        msg.textContent = "Selecione uma imagem.";
        msg.style.color = "#ff5555";
        return;
    }

    const imagem = imagemInput.files[0];

    try {

        msg.textContent = "Cadastrando produto...";
        msg.style.color = "#d4af37";

        // ================================
        // VERIFICAR LOGIN
        // ================================

        const {
            data: { session }
        } = await supabaseClient.auth.getSession();

        if (!session) {
            msg.textContent = "Sua sessão expirou. Faça login novamente.";
            msg.style.color = "#ff5555";
            return;
        }

        // ================================
        // UPLOAD DA IMAGEM
        // ================================

        const nomeArquivo =
            `${Date.now()}-${imagem.name.replace(/[^a-zA-Z0-9.-]/g, "_")}`;

        const caminhoImagem = `Fotos/${nomeArquivo}`;

        const { error: uploadError } = await supabaseClient
            .storage
            .from("produtos")
            .upload(caminhoImagem, imagem);

        if (uploadError) {
            console.error("Erro ao enviar imagem:", uploadError);

            msg.textContent = "Erro ao enviar a imagem.";
            msg.style.color = "#ff5555";
            return;
        }

        // ================================
        // PEGAR URL DA IMAGEM
        // ================================

        const { data: imagemPublica } = supabaseClient
            .storage
            .from("produtos")
            .getPublicUrl(caminhoImagem);

        const imagemUrl = imagemPublica.publicUrl;

        // ================================
        // CADASTRAR PRODUTO
        // ================================

        const { data: produtoCriado, error: produtoError } =
            await supabaseClient
                .from("produtos")
                .insert([{
                    nome: nome,
                    categoria: categoria,
                    preco: preco,
                    estoque: estoque,
                    imagem_url: imagemUrl
                }])
                .select()
                .single();

        if (produtoError) {
            console.error("Erro ao cadastrar produto:", produtoError);

            // Tentar remover a imagem caso o cadastro falhe
            await supabaseClient
                .storage
                .from("produtos")
                .remove([caminhoImagem]);

            msg.textContent = "Erro ao cadastrar o produto.";
            msg.style.color = "#ff5555";
            return;
        }

        // ================================
        // CADASTRAR IMAGEM NA TABELA
        // produto_imagens
        // ================================

        const { error: imagemTabelaError } = await supabaseClient
            .from("produto_imagens")
            .insert([{
                produto_id: produtoCriado.id,
                url: imagemUrl,
                ordem: 0
            }]);

        if (imagemTabelaError) {
            console.error(
                "Erro ao cadastrar imagem na tabela:",
                imagemTabelaError
            );

            msg.textContent =
                "Produto cadastrado, mas houve erro ao salvar a imagem.";
            msg.style.color = "#ff9900";

            return;
        }

        // ================================
        // CADASTRAR TAMANHOS
        // ================================

        const dadosTamanhos = tamanhosSelecionados.map(item => ({
            produto_id: produtoCriado.id,
            tamanho: item.tamanho,
            estoque: Number(item.estoque)
        }));

        const { error: tamanhosError } = await supabaseClient
            .from("produto_tamanhos")
            .insert(dadosTamanhos);

        if (tamanhosError) {
            console.error(
                "Erro ao cadastrar tamanhos:",
                tamanhosError
            );

            msg.textContent =
                "Produto cadastrado, mas houve erro ao salvar os tamanhos.";
            msg.style.color = "#ff9900";

            return;
        }

        // ================================
        // LIMPAR FORMULÁRIO
        // ================================

        document.getElementById("formNovoProduto").reset();

        document.getElementById("opcoesTamanhosCadastro").innerHTML =
            `<p style="color:#888;">Selecione primeiro uma categoria.</p>`;

        document.getElementById("estoqueTotalCadastro").textContent =
            "Estoque total: 0";

        // ================================
        // SUCESSO
        // ================================

        msg.textContent = "Produto cadastrado com sucesso!";
        msg.style.color = "#4CAF50";

        // Atualizar tabela
        await carregarProdutosAdmin();

    } catch (error) {

        console.error("Erro inesperado:", error);

        msg.textContent =
            "Ocorreu um erro inesperado ao cadastrar o produto.";

        msg.style.color = "#ff5555";
    }
}


// =========================================================
// INICIALIZAÇÃO DO PAINEL
// =========================================================

async function initAdmin() {
    ocultarPainel();
    try {
        const {
            data: { session },
            error
        } = await supabaseClient.auth.getSession();

        if (error) {
            document.getElementById("loginError").textContent = "Não foi possível verificar a sessão. Entre novamente.";
            return;
        }

        await verificarAcessoAdmin(session);

    } catch (error) {
        ocultarPainel();
        document.getElementById("loginError").textContent = "Não foi possível verificar a sessão. Entre novamente.";
    }
}


// =========================================================
// OBSERVAR ALTERAÇÕES DE LOGIN
// =========================================================

supabaseClient.auth.onAuthStateChange(
    (event, session) => {

        verificacaoAdmin++;
        ocultarPainel();
        // Não aguardar chamadas Supabase dentro do callback de autenticação.
        if (session) setTimeout(() => verificarAcessoAdmin(session), 0);
    }
);


// =========================================================
// INICIAR
// =========================================================

document.addEventListener("DOMContentLoaded", () => {
    initAdmin();
});
/* =========================================================
   DASHBOARD DE ESTOQUE
   ========================================================= */

async function carregarDashboardEstoque() {

    try {

        // Buscar produtos
        const { data: produtos, error: erroProdutos } =
            await supabaseClient
                .from("produtos")
                .select("*");

        if (erroProdutos) {
            console.error("Erro ao carregar produtos:", erroProdutos);
            return;
        }

        // Buscar estoques por tamanho
        const { data: tamanhos, error: erroTamanhos } =
            await supabaseClient
                .from("produto_tamanhos")
                .select("produto_id, tamanho, estoque");

        if (erroTamanhos) {
            console.error("Erro ao carregar tamanhos:", erroTamanhos);
            return;
        }


        /* =====================================================
           CALCULAR ESTOQUE REAL DE CADA PRODUTO
           ===================================================== */

        const estoquePorProduto = {};

        // Primeiro, soma o estoque por tamanho
        tamanhos.forEach(item => {

            if (!estoquePorProduto[item.produto_id]) {
                estoquePorProduto[item.produto_id] = 0;
            }

            estoquePorProduto[item.produto_id] += Number(item.estoque) || 0;

        });


        /* =====================================================
           CLASSIFICAÇÃO
           ===================================================== */

        let totalProdutos = produtos.length;

        let estoqueNormal = 0;
        let quaseAcabando = 0;
        let semEstoque = 0;

        const produtosAlerta = [];


        produtos.forEach(produto => {

            /*
             * Se o produto possui tamanhos cadastrados,
             * usamos a soma dos estoques por tamanho.
             *
             * Caso não tenha tamanhos, usamos o estoque
             * tradicional da tabela produtos.
             */

            const possuiTamanhos =
                Object.prototype.hasOwnProperty.call(
                    estoquePorProduto,
                    produto.id
                );

            const estoque = possuiTamanhos
                ? estoquePorProduto[produto.id]
                : Number(produto.estoque) || 0;


            // SEM ESTOQUE
            if (estoque <= 0) {

                semEstoque++;

                produtosAlerta.push({
                    ...produto,
                    estoqueReal: 0,
                    tipoAlerta: "sem"
                });

            }

            // QUASE ACABANDO
            else if (estoque <= 5) {

                quaseAcabando++;

                produtosAlerta.push({
                    ...produto,
                    estoqueReal: estoque,
                    tipoAlerta: "quase"
                });

            }

            // ESTOQUE NORMAL
            else {

                estoqueNormal++;

            }

        });


        /* =====================================================
           ATUALIZAR CARDS
           ===================================================== */

        document.getElementById(
            "dashboardTotalProdutos"
        ).textContent = totalProdutos;

        document.getElementById(
            "dashboardEstoqueNormal"
        ).textContent = estoqueNormal;

        document.getElementById(
            "dashboardQuaseAcabando"
        ).textContent = quaseAcabando;

        document.getElementById(
            "dashboardSemEstoque"
        ).textContent = semEstoque;


        /* =====================================================
           ATUALIZAR VALORES DO GRÁFICO
           ===================================================== */

        document.getElementById(
            "graficoNormalValor"
        ).textContent = estoqueNormal;

        document.getElementById(
            "graficoAlertaValor"
        ).textContent = quaseAcabando;

        document.getElementById(
            "graficoFaltaValor"
        ).textContent = semEstoque;


        /* =====================================================
           CALCULAR PORCENTAGENS DAS BARRAS
           ===================================================== */

        const totalClassificados =
            estoqueNormal +
            quaseAcabando +
            semEstoque;


        let porcentagemNormal = 0;
        let porcentagemAlerta = 0;
        let porcentagemFalta = 0;


        if (totalClassificados > 0) {

            porcentagemNormal =
                (estoqueNormal / totalClassificados) * 100;

            porcentagemAlerta =
                (quaseAcabando / totalClassificados) * 100;

            porcentagemFalta =
                (semEstoque / totalClassificados) * 100;

        }


        document.getElementById(
            "graficoNormalBarra"
        ).style.width = `${porcentagemNormal}%`;

        document.getElementById(
            "graficoAlertaBarra"
        ).style.width = `${porcentagemAlerta}%`;

        document.getElementById(
            "graficoFaltaBarra"
        ).style.width = `${porcentagemFalta}%`;


        /* =====================================================
           ORDENAR ALERTAS
           ===================================================== */

        produtosAlerta.sort(
            (a, b) => a.estoqueReal - b.estoqueReal
        );


        /* =====================================================
           MOSTRAR PRODUTOS EM ALERTA
           ===================================================== */

        const lista =
            document.getElementById("dashboardListaAlertas");


        if (produtosAlerta.length === 0) {

            lista.innerHTML = `
                <div class="dashboard-carregando">
                    ✅ Todos os produtos estão com estoque normal.
                </div>
            `;

            return;

        }


        lista.innerHTML = produtosAlerta.map(produto => {

            const categoria =
                produto.categoria || "Sem categoria";


            if (produto.tipoAlerta === "sem") {

                return `
                    <div class="dashboard-alerta-produto">

                        <div class="dashboard-alerta-produto-info">

                            <span class="dashboard-alerta-produto-nome">
                                ${escapeHtml(produto.nome)}
                            </span>

                            <span class="dashboard-alerta-produto-categoria">
                                ${escapeHtml(categoria)}
                            </span>

                        </div>

                        <span class="dashboard-alerta-estoque dashboard-alerta-sem-estoque">
                            🔴 Sem estoque
                        </span>

                    </div>
                `;

            }


            return `
                <div class="dashboard-alerta-produto">

                    <div class="dashboard-alerta-produto-info">

                        <span class="dashboard-alerta-produto-nome">
                            ${escapeHtml(produto.nome)}
                        </span>

                        <span class="dashboard-alerta-produto-categoria">
                            ${escapeHtml(categoria)}
                        </span>

                    </div>

                    <span class="dashboard-alerta-estoque dashboard-alerta-quase">
                        🟡 ${produto.estoqueReal} unidade${produto.estoqueReal === 1 ? "" : "s"}
                    </span>

                </div>
            `;

        }).join("");


    } catch (erro) {

        console.error(
            "Erro inesperado no dashboard:",
            erro
        );

    }

}

