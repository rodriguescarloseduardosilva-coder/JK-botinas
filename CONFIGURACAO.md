# Configuração da JK Botinas

## 1. Aplicar o banco

No SQL Editor do mesmo projeto Supabase usado em `supabase-config.js`, execute uma única vez:

`supabase/migrations/20261002_clientes_pedidos.sql`

Essa migração cria os clientes e pedidos, ativa RLS e substitui a baixa direta de estoque por uma confirmação administrativa. Ela não cria cobrança e não emite nota fiscal.

## 2. Configurar o acesso de clientes

> **Atenção:** a migração acima não acompanha a versão inicial deste repositório. Recupere o SQL do projeto existente antes de tentar recriar o banco. A migração Pix depende desse esquema e não o substitui.

No painel Supabase:

1. Em **Authentication → Providers**, mantenha **Email** habilitado.
2. Em **Authentication → URL Configuration**, inclua a URL publicada da loja em **Site URL** e em **Redirect URLs**.
3. Para produção, configure um SMTP próprio para os e-mails de confirmação e recuperação de senha.

O cadastro do cliente só fica completo depois da confirmação do e-mail e do preenchimento de nome, CPF e telefone.

## 3. Autorizar a equipe

Somente usuários cujo `app_metadata` contenha `{"loja_admin": true}` podem alterar produtos, consultar todos os pedidos e confirmar uma venda. Esse atributo deve ser definido pelo painel administrativo/API confiável; nunca use `user_metadata` para autorização.

## 4. Nota fiscal

O pedido é salvo com `fiscal_status = nao_configurado`. O sistema não deve mostrar “nota fiscal emitida” antes de uma integração real retornar a autorização fiscal. Para automatizar isso, escolha um emissor compatível com a empresa (por exemplo, um ERP ou provedor de NF-e/NFC-e), faça o credenciamento fiscal e implemente a chamada no servidor usando as credenciais e o certificado da empresa. Não coloque certificado, chave secreta ou `service_role` no JavaScript público.

## Pagamento somente por Pix

Veja [PIX.md](PIX.md) para instalar e homologar a integração automática com o Banco do Brasil. A cobrança fica desativada até a habilitação bancária e a configuração dos segredos no servidor. O cliente não pode confirmar o próprio pagamento; a confirmação depende da consulta ao banco. A equipe define o frete antes de liberar o valor final.

## 5. Teste rápido

- Abra `index.html`: o catálogo fica bloqueado até o login.
- Crie um usuário, confirme o e-mail, e complete o perfil.
- Adicione um produto, escolha o tamanho quando houver, informe o endereço e registre o pedido.
- Após instalar e homologar o Pix, defina frete e desconto no painel. O cliente gera a cobrança em “Meus pedidos”; só a confirmação bancária libera a confirmação administrativa da venda e a baixa de estoque.
- Verifique em “Meus pedidos” que o pedido continua marcado como aguardando configuração da emissão fiscal.

