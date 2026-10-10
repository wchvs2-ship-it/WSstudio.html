# Publicar gratuitamente na Cloudflare

O site continua no GitHub Pages. A API, o painel e o banco de pedidos ficam em um Cloudflare Worker com Durable Object SQLite, que conserva os dados entre publicações. Esta opção usa o plano **Workers Free** e dispensa um servidor Node separado.

## 1. Criar a conta gratuita

Crie uma conta em [Cloudflare](https://dash.cloudflare.com/sign-up), confirme o e-mail e mantenha o plano Workers Free. Não compre domínio, não selecione upgrade e não ative serviços pagos. O endereço gratuito da API termina em `workers.dev`.

Consulte as cotas atuais em [Workers](https://developers.cloudflare.com/workers/platform/pricing/) e [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/). No plano gratuito, as cotas publicadas incluem 100 mil requisições diárias para Workers e 100 mil requisições diárias, 13 mil GB-segundos diários e 5 GB de armazenamento para Durable Objects SQLite. O tempo de CPU por requisição do Durable Object tem limite padrão de 30 segundos. Ao exceder uma cota, o serviço pode interromper operações até a renovação; o plano gratuito não é ilimitado. Não é necessário ativar Workers Paid para esta configuração.

## 2. Autorizar a publicação

No terminal de uma máquina com Node 24 e o repositório:

```sh
npm ci
npm run cloud:login
```

O login abre o navegador para autorizar a sua própria conta Cloudflare. Em um ambiente sem navegador local, use o gerenciador seguro de segredos do ambiente para cadastrar `CLOUDFLARE_API_TOKEN` e, se necessário para selecionar a conta, `CLOUDFLARE_ACCOUNT_ID`. Use um token restrito à sua conta, com as permissões exigidas pelo Wrangler para publicar Workers, assets e Durable Objects. Não coloque tokens no repositório, no chat ou em `api-config.js`.

Se o Wrangler pedir um subdomínio Workers, escolha o endereço gratuito no painel **Workers & Pages**. Não precisa fornecer um token GitHub para publicar a API.

## 3. Publicar e verificar a API

```sh
npm run cloud:check
npm run cloud:deploy
```

O primeiro comando valida a compilação sem publicar. O segundo publica na conta autorizada e verifica saúde, catálogo, exigência de login, bloqueio de arquivos privados e permissão do GitHub Pages para enviar pedidos. A URL verificada fica em `.cloudflare/deployment.json`, que é um arquivo local gerado. O pacote de assets contém somente os oito arquivos públicos definidos em `cloudflare/build.mjs`.

## 4. Cadastrar a senha do painel

```sh
npm run cloud:adminsetup
npm run cloud:deploy
```

O primeiro comando solicita a senha sem exibi-la e publica somente seu hash como segredo `ADMIN_PASSWORD_HASH`. O usuário padrão é `william`, configurado em `wrangler.jsonc`. Guarde a senha no seu gerenciador de senhas. A senha não vai para o código nem para o site público. Até cadastrar o segredo, o login permanece indisponível. O segundo comando confere a publicação com a configuração final.

No ambiente Codex, a senha também pode ser fornecida no campo privado de variáveis do ambiente, com o nome `WS_ADMIN_PASSWORD`, e cadastrada com `npm run cloud:adminsetup -- --from-env`. Essa variável precisa conter o valor local do processo, sem o mecanismo de substituição de tokens pelo proxy. O script calcula o hash em memória; a senha não é passada ao Wrangler nem exibida. Remova a variável privada depois de cadastrar e conferir o acesso. `CLOUDFLARE_API_TOKEN` é o segredo de acesso à API da Cloudflare e tem uma finalidade diferente.

Abra `https://SEU-WORKER.workers.dev/admin/` para entrar no painel. O painel usa a mesma origem da API; não abra o painel administrativo no GitHub Pages.

## 5. Conectar o site do GitHub Pages

Depois da verificação, substitua a configuração de `api-config.js` pela URL real:

```js
window.WS_API_CONFIG = Object.freeze({
  enabled: true,
  baseUrl: 'https://SEU-WORKER.workers.dev',
});
```

Publique essa alteração no GitHub. `ALLOWED_ORIGINS` em `wrangler.jsonc` já permite `https://wchvs2-ship-it.github.io`, sem o caminho do repositório. Se o site mudar de origem, atualize essa configuração e publique a API novamente.

Faça um pedido de teste pelo site, entre no painel e confira o orçamento, a confirmação manual da entrada, a entrega e a confirmação do saldo. Os testes de publicação não criam pedidos e não registram pagamentos. Confira o recebimento no aplicativo do banco antes de confirmar Pix no painel.

## Desenvolvimento e manutenção

Para testar o painel localmente:

```sh
npm run cloud:build
npm run cloud:adminsetup -- --local
npm run cloud:dev
```

O cadastro local guarda somente o hash da senha em `.dev.vars`, que fica fora do Git. `cloud:dev` executa o Worker com armazenamento local próprio. A senha e os pedidos do backend Node local não são copiados para a nuvem; exportação/migração de dados precisa ser planejada se já houver pedidos reais. O backend Node original continua disponível com `npm start`.

Para alterar o código, repita `npm run cloud:check` e `npm run cloud:deploy`. Preserve o binding `STUDIO_API`, a classe `StudioApi` e a migração `v1`, pois eles identificam o armazenamento já criado. Para trocar a senha publicada, execute novamente `npm run cloud:adminsetup` e confira o acesso. Para trocar a senha local, use `npm run cloud:adminsetup -- --local --force` e reinicie `cloud:dev`. Os valores de domínio, hospedagem e anúncios vendidos aos clientes não incluem a compra de serviços Cloudflare pagos.
