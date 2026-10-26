# Configuração da JK Botinas

## 1. Aplicar o banco

No SQL Editor do mesmo projeto Supabase usado em `supabase-config.js`, execute uma única vez:

`supabase/migrations/20261002_clientes_pedidos.sql`

Essa migração cria os clientes e pedidos, ativa RLS e substitui a baixa direta de estoque por uma confirmação administrativa. Ela não cria cobrança e não emite nota fiscal.

## 2. Configurar o acesso de clientes

No painel Supabase:

1. Em **Authentication → Providers**, mantenha **Email** habilitado.
2. Em **Authentication → URL Configuration**, inclua a URL publicada da loja em **Site URL** e em **Redirect URLs**.
3. Para produção, configure um SMTP próprio para os e-mails de confirmação e recuperação de senha.

O cadastro do cliente só fica completo depois da confirmação do e-mail e do preenchimento de nome, CPF e telefone.

## 3. Autorizar a equipe

Somente usuários cujo `app_metadata` contenha `{"loja_admin": true}` podem alterar produtos, consultar todos os pedidos e confirmar uma venda. Esse atributo deve ser definido pelo painel administrativo/API confiável; nunca use `user_metadata` para autorização.

## 4. Nota fiscal

O painel administrativo possui acesso ao módulo independente de NF-e, para vendas do site, loja e WhatsApp. A instalação, o emissor, a configuração segura e a homologação estão descritos em [FISCAL.md](FISCAL.md). Aplique a migração fiscal e configure o servidor antes de utilizar o módulo.

A situação fiscal válida é consultada no módulo de notas. O campo antigo `fiscal_status` do pedido não é atualizado por esta integração. Não coloque certificado, chave secreta ou `service_role` no JavaScript público.

## 5. Teste rápido

- Abra `index.html`: o catálogo fica bloqueado até o login.
- Crie um usuário, confirme o e-mail, e complete o perfil.
- Adicione um produto, escolha o tamanho quando houver, informe o endereço e registre o pedido.
- Confirme no painel administrativo; só então o estoque é baixado.
- Abra o módulo de notas no painel para conferir a emissão. “Meus pedidos” ainda utiliza o campo fiscal antigo do pedido.

