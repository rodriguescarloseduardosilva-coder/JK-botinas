# Pix automático — Banco do Brasil

Esta implementação oferece somente Pix. Não inclui cartão nem confirmação manual de pagamento.

**Situação de ativação:** o código precisa ser validado com a aplicação habilitada no BB e com o banco Supabase real antes de produção. A cobrança fica bloqueada por padrão (`BB_PIX_ENABLED=false`). Nenhuma credencial bancária foi incluída no repositório.

## Fluxo

1. O cliente registra o pedido com os dados já usados pela loja.
2. A equipe confere disponibilidade e informa frete e desconto em **Salvar valor do Pix**. Frete zero significa retirada ou entrega sem cobrança; não é calculado automaticamente.
3. Em **Meus pedidos → Ver pagamento Pix**, o cliente solicita a cobrança. O servidor lê o valor final do banco de dados, bloqueia alterações e usa um identificador bancário estável por pedido.
4. O BB retorna o código Pix. O QR Code é gerado no próprio servidor, sem enviar o código para um serviço externo de imagens.
5. A tela consulta a cobrança a cada 15 segundos enquanto aberta e visível. A consulta também acontece ao reabrir o pagamento. Só um recebimento integral, identificado pelo banco e com valor e pedido correspondentes, confirma o Pix.
6. Após o pagamento confirmado, a equipe pode confirmar a venda e baixar o estoque pelo fluxo existente. Essa ação não confirma manualmente o pagamento e ainda não emite nota fiscal.

Não há webhook nesta versão. Uma página fechada não mantém consultas em execução; a atualização ocorre na próxima consulta do cliente ou da equipe. Se for necessária conciliação contínua sem página aberta, configurar posteriormente um reconciliador no servidor ou um endpoint com os requisitos de mTLS do BB. Não cadastrar a rota `/api/pix` como webhook.

## Antes de instalar

- Habilitar a API Pix da conta empresarial, ter chave Pix ativa no BB e cadastrar a aplicação no Portal Developers. Seguir os testes e a promoção para produção orientados pelo banco.
- Obter no portal os endereços **atuais** de OAuth e da base Pix, permissões, credenciais e certificado exigido para essa aplicação. Os endereços não foram presumidos nem fixados no código.
- Recuperar o SQL original do projeto Supabase. `CONFIGURACAO.md` cita `supabase/migrations/20261002_clientes_pedidos.sql`, ausente da versão inicial deste repositório. Esta alteração não reconstrói esse banco.
- Conferir as regras de estoque do banco existente antes de aceitar cobranças simultâneas. A implementação Pix não cria uma reserva de estoque; a loja precisa conferir disponibilidade antes de liberar o valor. Conferir também o procedimento de devolução de um recebimento quando a venda não puder ser atendida.

## Banco de dados

Após revisar o esquema real e fazer backup, aplicar `supabase/migrations/20261026_pix.sql` no projeto Supabase correto. A migração exige `public.jk_pedidos` com `id` e `cliente_id` UUID, `total` numérico, `status`, além da função de autorização existente `public.jk_e_admin()`.

Ela adiciona:

- Uma cobrança por pedido, com valor de produtos, frete, desconto e identificador bancário.
- Leitura limitada ao dono do pedido e à equipe; clientes não podem editar pagamentos ou marcar o próprio pedido como pago.
- Preparação do valor apenas por administradores, antes do início da cobrança.
- Funções de atualização bancária executáveis somente pelo servidor com `service_role`.
- Um bloqueio no banco para impedir nova confirmação de venda sem Pix pago. Pedidos que já estavam confirmados preservam seu histórico.

Os testes SQL usam um esquema mínimo de teste. Eles não comprovam a instalação, as permissões ou a compatibilidade das funções legadas do projeto real.

## Servidor e hospedagem

As rotas `api/pix.js` e as bibliotecas em `lib/` usam Node.js, compatível com funções Node na Vercel. O site deve servir a API na **mesma origem** do HTML. Hospedagem somente estática não executa a API. Configurar o projeto como **Other**, com a raiz deste repositório e sem comando de build para o HTML; verificar a detecção da função `/api/pix` na publicação de teste.

`vercel.json` permite até 120 segundos para a função, para acomodar autenticação, consulta, geração e recuperação após timeout. Conferir o limite disponível no plano de hospedagem antes de ativar. Cada requisição ao banco tem prazo de 12 segundos e cada chamada Supabase, 10 segundos; se a plataforma interromper uma resposta, a próxima tentativa consulta o mesmo identificador antes de tentar criar a cobrança.

Instalar as dependências com `npm ci`. Usar o arquivo `.env.example` como lista de nomes; cadastrar os valores no gerenciador de variáveis da hospedagem. Certificados, chaves privadas, `client_secret` e `service_role` pertencem somente ao servidor. Não colocar valores em `supabase-config.js`, HTML, commits ou mensagens.

O backend usa saída HTTPS com certificado de cliente e valida o certificado do banco. Somente hosts HTTPS sob `.bb.com.br` são aceitos para OAuth e Pix. A integração assume os endpoints e formatos de cobrança imediata `GET/PUT /cob/{txid}` do padrão API Pix; conferir a base, permissões e os retornos específicos disponibilizados pelo BB após a habilitação.

`BB_PIX_ENVIRONMENT=production` e `BB_PIX_ENABLED=true` são necessários para o endpoint de pagamento. Não ativar com credenciais de homologação em uma loja real. Usar aplicação, banco e hospedagem isolados para os testes de homologação do banco; o gate não transforma testes simulados em confirmação financeira real.

## Validação antes da ativação

Executar `npm test`. Os testes automatizados usam respostas simuladas e banco de teste local; não cobram nem acessam a conta BB.

No ambiente de homologação isolado, validar com o BB: autenticação/certificado, geração e leitura da mesma cobrança, código/QR, vencimento, pagamento, divergência de valor, recuperação após interrupção e consultas simultâneas. Validar também um cliente tentando acessar o pedido de outro, confirmação de venda sem pagamento e integridade da baixa de estoque real.

Só após a homologação e a configuração de produção, habilitar a cobrança real. Validar recebimento de uma operação autorizada de pequeno valor e conferi-lo no extrato. Não informar ao cliente “pago” a partir de cliques, comprovantes ou retorno de navegação.

Uma cobrança vencida não é substituída automaticamente por outra: consultar primeiro o banco e resolver com a loja, evitando dois pagamentos para o mesmo pedido. Cancelamentos, estornos e pagamentos parciais não têm fluxo automático nesta versão; divergências interrompem a confirmação e devem ser tratadas pelos canais do banco.

## Referências

- [API Pix BB e pré-requisitos](https://www.bb.com.br/site/developers/api-pix/)
- [Primeiros passos no Portal Developers BB](https://www.bb.com.br/site/developers/primeiros-passos/)
- [Padrão API Pix — Banco Central](https://github.com/bacen/pix-api)
