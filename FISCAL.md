# Notas fiscais da JK Botinas

O painel `fiscal.html` permite iniciar uma NF-e para uma venda da loja, do WhatsApp ou do site, salvar o rascunho, revisar, enviar, consultar a autorização, baixar DANFE/XML e solicitar cancelamento. A emissão é uma ação administrativa independente do recebimento por Pix e da confirmação de estoque.

Esta entrega prepara a integração com a Focus NFe. Não cria conta no emissor, não contrata plano, não configura certificado e não habilita emissão real. A disponibilidade do painel não garante disponibilidade da SEFAZ ou do emissor.

## Instalação

1. No mesmo projeto Supabase de `supabase-config.js`, aplique `supabase/migrations/20261026_notas_fiscais.sql` pelo SQL Editor. Ela cria tabelas e funções fiscais próprias. A emissão avulsa não depende das tabelas antigas de pedidos; copiar um pedido depende de `jk_pedidos` já existir com acesso administrativo.
2. Autorize cada integrante da equipe com `app_metadata.loja_admin = true`, pelo painel/API confiável do Supabase. `user_metadata` não concede acesso. Renove a sessão depois da alteração.
3. Publique os arquivos em uma hospedagem que execute a função Node `api/fiscal.js`. O projeto já possui configuração para Vercel. Confirme que a hospedagem usa este repositório/branch; um repositório fork não altera automaticamente a publicação do repositório original.
4. Configure as variáveis abaixo no servidor. Use o mesmo projeto Supabase do navegador. Os rascunhos funcionam sem token Focus; a revisão também precisa da função Node e das variáveis Supabase.
5. Abra **Painel → Notas fiscais → Configuração fiscal**. Informe o emitente do DF, Simples Nacional, e importe os perfis preparados pela contabilidade. Salve a configuração antes de revisar uma nota.

| Variável | Valor / uso |
| --- | --- |
| `SUPABASE_URL` | URL HTTPS do projeto |
| `SUPABASE_ANON_KEY` | Chave pública do mesmo projeto |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave secreta, somente no servidor; reserva e registra as tentativas |
| `FISCAL_ENABLED` | `false` inicialmente; `true` libera chamadas ao emissor |
| `FISCAL_ENVIRONMENT` | `homologacao` para testes ou `producao` para documentos reais |
| `FOCUS_NFE_TOKEN` | Token do ambiente escolhido, somente no servidor |
| `FISCAL_SITE_ORIGIN` | Origem HTTPS exata da publicação, sem barra final; se omitida, exige a mesma origem da função |

Não coloque token, senha, certificado ou `service_role` em `supabase-config.js`, perfis, HTML, commits ou mensagens. Cadastre o certificado diretamente na área segura do emissor. A integração preparada utiliza o cadastro de empresa com certificado **A1**; caso o certificado atual seja A3, verifique a alternativa com o emissor antes da ativação. Série, próximo número, empresa e habilitação dos ambientes devem ser conferidos no emissor com a contabilidade. [Cadastro da empresa](https://doc.focusnfe.com.br/docs/como-cadastrar-uma-empresa), [ambientes](https://doc.focusnfe.com.br/reference/ambiente), [autenticação](https://doc.focusnfe.com.br/reference/autenticacao).

## Perfis fiscais

`fiscal-perfis.modelo.json` é um formulário vazio, deliberadamente inválido até o preenchimento. Não oferece NCM, CFOP, CSOSN ou alíquotas presumidas. A contabilidade deve fornecer os valores e validar o resultado fiscal em homologação.

Cada perfil tem `id` único, `nome`, escopo `uf_destino`, `tipo_documento` (`cpf`/`cnpj`), `presenca_comprador` (1, 2, 3 ou 9), e `campos_fiscais` com os nomes esperados pela API Focus. A unidade pode ser fixada em `campos_fiscais.unidade_comercial`. Os campos adicionais da nota ficam em `campos_adicionais`, incluindo finalidade e modalidade de frete. [Campos da nota](https://campos.focusnfe.com.br/nfe/NotaFiscalXML.html), [campos dos itens](https://campos.focusnfe.com.br/nfe/ItemNotaFiscalXML.html).

O servidor valida o escopo e recalcula produtos, rateios, total e pagamento usando decimais exatos. Ele não é um motor tributário genérico: não infere bases, benefícios ou valores de impostos a partir de uma alíquota. Composições que exigem dados ausentes são bloqueadas na revisão.

Quando o perfil contém bases ou valores monetários positivos, inclua `valores_vinculados` no perfil para a operação específica: `codigo`, `quantidade`, `preco_unitario`, `frete`, `desconto`, `seguro`, `outras_despesas`. Os últimos quatro valores são as parcelas **do item após o rateio**, com duas casas decimais; quantidade/preço aceitam até quatro casas. Qualquer mudança nesses valores exige atualizar o perfil antes da revisão. Isso impede reutilizar valores tributários quando os valores comerciais vinculados mudam. Perfis com impostos zero também precisam de validação contábil; zero não é uma escolha padrão do sistema.

O escopo inicial é NF-e de venda com emitente DF/CRT 1 e destinatário identificado no Brasil. Não contempla NFC-e, NFS-e, exportação, contingência offline, devoluções assistidas, carta de correção ou inutilização. IBS/CBS/IS com alíquotas ou valores positivos e parcelas tributárias sem composição homologada são bloqueados. Não use este módulo para uma operação que a contabilidade não tenha validado e testado no emissor.

Importar um arquivo apenas prepara a alteração. É necessário **Salvar configuração fiscal**, ou **Descartar alterações**, antes de salvar/revisar uma nota. Mudanças na configuração invalidam a revisão de rascunhos antigos; salve e revise o rascunho novamente.

## Homologação antes de produção

1. Configure `FISCAL_ENVIRONMENT=homologacao`, token de homologação e `FISCAL_ENABLED=true` no ambiente de teste. Previews da Vercel só permitem homologação; produção fica bloqueada em preview.
2. Use dados de teste aceitos pelo emissor, com empresa/certificado e perfis revisados. Faça uma emissão de homologação e confira o XML/DANFE, destinatário, itens, valores, tributos e situação com a contabilidade. O nome do destinatário é substituído pela identificação exigida no ambiente de homologação.
3. Confira autorização e rejeição, correção de um rascunho rejeitado, consulta após interrupção, download de XML/DANFE e cancelamento quando permitido. Os testes automatizados usam respostas simuladas; não substituem essa validação fiscal.
4. Somente depois dessa conferência configure o token de produção e `FISCAL_ENVIRONMENT=producao` na publicação de produção. A tela mostra o ambiente antes do envio. Notas já enviadas permanecem vinculadas ao ambiente original; consulte-as usando esse ambiente.

Esta entrega não inclui credenciais, emissão de homologação no emissor, emissão de produção nem implantação no banco/hospedagem.

## Uso diário e recuperação

Abra **Nova nota**, preencha a venda e os produtos, salve, clique em **Revisar para emitir**, confira o ambiente e o total calculado no servidor, marque a confirmação e envie. No pedido existente, **Criar rascunho de nota fiscal** aproveita os dados disponíveis; complete os campos faltantes. Se o pedido já tem documento, o painel abre o histórico correspondente para conferência.

“Enviando” e “Em processamento” não significam autorização. O painel só mostra “Autorizada” depois de uma resposta validada do emissor. DANFE/XML são disponibilizados pelo servidor, com autenticação, depois da autorização. [Emissão](https://doc.focusnfe.com.br/reference/emitir_nfe), [consulta](https://doc.focusnfe.com.br/reference/consultar_nfe).

Após uma falha ou timeout, consulte **a mesma nota** no histórico. O sistema conserva referência, ambiente e snapshot para evitar duplicação. Só corrija quando a rejeição da tentativa estiver confirmada. Se uma resposta incompleta ou uma validação HTTP do emissor deixar o envio indefinido, peça ao suporte do emissor para localizar a referência mostrada no histórico; não apague a reserva nem crie outra nota até confirmar se houve autorização. Não há desbloqueio automático para uma situação fiscal incerta. [Referências](https://doc.focusnfe.com.br/reference/referencia).

O histórico consulta até três notas pendentes a cada 20 segundos enquanto a aba está visível. Não há webhook nem trabalhador em segundo plano: com a página fechada, a atualização ocorre quando a equipe voltar e consultar. Se necessário, implante posteriormente uma rotina autenticada de reconciliação.

O cancelamento exige justificativa de 15 a 255 caracteres e só muda a situação após nova consulta confirmada; sua aceitação depende do emissor/SEFAZ. [Cancelamento](https://doc.focusnfe.com.br/reference/cancelar_nfe).

## Verificação técnica

Use Node 20 ou superior: `npm ci` e `npm test`. A suíte cobre autenticação, cálculo decimal, reservas concorrentes/versões, RLS e estados em PostgreSQL/PGlite, segurança dos documentos e fluxos administrativos em jsdom. Não realiza chamadas fiscais reais.

Esta alteração foi construída a partir de `main`, separada da PR Pix. Caso ambas sejam incorporadas, preserve os dois endpoints, as migrações de cada módulo, scripts/testes e variáveis de ambiente ao resolver conflitos em `package.json`, `vercel.json`, `.env.example` e arquivos do painel. O módulo fiscal não confirma pagamento nem dá baixa de estoque.
