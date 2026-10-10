# WSstudio

Aplicação em português para apresentar serviços, registrar pedidos de orçamento e administrar a contratação com pagamento manual em duas etapas. A vitrine pode continuar no GitHub Pages. A implantação gratuita usa Cloudflare Workers com banco SQLite permanente em um Durable Object; o servidor Node também continua disponível para desenvolvimento.

## Hospedagem gratuita

O passo a passo está em [docs/DEPLOY-GRATUITO.md](docs/DEPLOY-GRATUITO.md). O plano Workers Free fornece o endereço HTTPS da API e mantém os pedidos entre publicações, dentro das cotas gratuitas. A verificação de senha e os dados ficam no Durable Object privado.

Para desenvolver essa versão, instale as dependências e execute:

```sh
npm ci --cache /workspace/.npm-cache --ignore-scripts
npm run cloud:check
npm run cloud:adminsetup -- --local
npm run cloud:dev
```

O cadastro solicita uma senha com entrada oculta e guarda somente seu hash em `.dev.vars`, fora do Git. O Worker local usa a porta 8787 e armazenamento em `.wrangler`; esses dados não são copiados automaticamente para a nuvem. `npm run cloud:deploy` publica somente depois que a conta Cloudflare estiver autorizada. As credenciais e os dados de teste são separados da configuração pública da vitrine.

## Desenvolvimento com Node

Requer Node.js 24 ou superior. A versão do ambiente está em `.node-version`.

Na pasta `/workspace/WSstudio.html`:

```sh
npm ci --cache /workspace/.npm-cache --ignore-scripts
npm run admin:setup
npm start
```

O cadastro do administrador pede uma senha de pelo menos 12 caracteres sem exibi-la no terminal. Ele grava apenas o hash em `.data/admin-auth.json`, com acesso restrito. Para alterar a senha local, execute `npm run admin:setup -- --force` e reinicie o backend; o reinício aplica a credencial e invalida as sessões antigas. Não envie senhas pelo chat nem as coloque nos arquivos públicos.

A API usa a porta 3000 por padrão. O mesmo servidor entrega a vitrine em `/` e o painel protegido em `/admin/`. `npm run dev` reinicia o servidor após mudanças. O arquivo `.env.example` apresenta as opções; `.env`, `node_modules` e `.data` ficam fora do Git.

O banco SQLite fica em `DATA_DIR` (padrão `.data`). Use armazenamento persistente em hospedagem e mantenha banco, credenciais e backups fora dos arquivos públicos. A aplicação protege as rotas do painel com sessão no servidor e verifica cada alteração. Clientes não têm acesso à lista de pedidos nem podem confirmar pagamentos.

Para testar a vitrine, utilize o servidor Node acima, que entrega apenas os arquivos públicos. O site continua compatível com a publicação estática no GitHub Pages.

## Pedidos e painel

Quando servido pelo Node, o formulário registra o pedido na API antes de mostrar o número de referência. Repetir uma tentativa cuja resposta foi perdida reaproveita o pedido. Falhas de envio mostram um erro, sem afirmar que o pedido foi registrado.

No painel, o estúdio pode:

1. Consultar pedidos e dados de contato.
2. Definir o orçamento final; entrada e saldo são calculados a partir desse valor.
3. Conferir a entrada no banco e registrar o recebimento manualmente, com uma referência.
4. Marcar a entrega do serviço.
5. Conferir e registrar o saldo, concluindo o pedido.

O painel não consulta o Nubank nem verifica comprovantes automaticamente. Gestão de manutenção é separada do valor do projeto. Valores públicos continuam sendo estimativas; o orçamento final é confirmado pelo estúdio. Projetos do portfólio continuam como conceitos demonstrativos.

## Conectar a API ao GitHub Pages

O GitHub Pages não executa o backend. `api-config.js` fica desativado até existir uma API hospedada. Nesse modo, o cliente prepara a proposta e continua pelo WhatsApp/e-mail, sem registro no banco.

Depois de hospedar a API com HTTPS e disco persistente, configure o arquivo público:

```js
window.WS_API_CONFIG = Object.freeze({
  enabled: true,
  baseUrl: 'https://SEU-ENDERECO-DA-API'
});
```

Essa configuração contém só um endereço público; nunca coloque credenciais nela. Na hospedagem, defina `ALLOWED_ORIGINS=https://wchvs2-ship-it.github.io` para permitir pedidos enviados pela vitrine. O painel funciona no domínio do backend. Configure `NODE_ENV=production`, `PORT`, `DATA_DIR` em volume persistente e `TRUST_PROXY` apenas de acordo com o proxy confiável da hospedagem. Cadastre o administrador de modo privado, por arquivo de hash ou `ADMIN_USERNAME` e `ADMIN_PASSWORD_HASH` nas configurações seguras do servidor.

Publicar código no GitHub e publicar a configuração do ambiente Codex são operações separadas de hospedar a API. Não ative o envio na vitrine antes de validar a API real.

## Serviços e condições comerciais

| Serviço | Valor informado |
| --- | --- |
| Landing page comum | R$ 490,90 a R$ 590,90 |
| Site institucional | R$ 590,90 a R$ 790,90 |
| Blog | R$ 340,90 |
| Cardápio | R$ 190,90 |
| Loja virtual | R$ 490,90 a R$ 690,90 |

- Inclusos na contratação: domínio e hospedagem por um ano e uma semana de gestão de tráfego.
- Tráfego pago: incluso durante a promoção conforme a faixa de valor do serviço; fora da promoção, contratado como serviço adicional sob orçamento.
- Prazo de entrega: em média quatro dias.
- Formas de pagamento: Pix, crédito ou débito; dinheiro somente em vendas presenciais.
- Condição de pagamento: 50% do valor final na contratação e os 50% restantes na entrega do serviço. O valor final é definido na proposta.
- Manutenção mensal: R$ 100,00 a R$ 150,00, cobrada separadamente do valor do serviço, com interesse indicado pelo cliente na solicitação.

Os valores em faixa dependem das condições do projeto e são confirmados na proposta. As faixas que incluem o tráfego pago, a verba dos anúncios e as demais condições da promoção serão confirmadas na proposta; não foram definidos orçamento de anúncios, percentuais ou escopos adicionais.

O aplicativo apresenta os dados fornecidos pelo estúdio para pagamento manual via Pix:

- Tipo de chave: celular.
- Chave Pix: (86) 98157-9130, no formato internacional `+5586981579130`.
- Beneficiário informado: William Carvalho do Nascimento.

A chave ainda não foi verificada no banco. O cliente deve conferir o beneficiário no aplicativo bancário antes de transferir. O pagamento ocorre somente após confirmar o orçamento: 50% na contratação e 50% na entrega, com a manutenção mensal cobrada separadamente. O aplicativo não realiza cobranças automáticas nem verifica recebimentos no banco; o estúdio confirma o recebimento na conta e registra a confirmação no painel. Não há QR code ou código Pix copia e cola gerados.

Para testar o fluxo de pagamento manual, é possível usar uma conta apta a receber Pix, incluindo Nubank. Qualquer transferência Pix movimenta dinheiro real, mesmo quando feita para teste. As telas e solicitações podem ser testadas sem transferências.

## Verificação

```sh
npm test
curl --fail http://127.0.0.1:3000/api/health
```

## Contatos do estúdio

- WhatsApp: +55 (86) 99491-1357 — https://wa.me/5586994911357
- E-mail: wcstudio.sites@gmail.com
- Instagram: @wcstudio.dev — https://www.instagram.com/wcstudio.dev/

Os links de contato aparecem no rodapé. WhatsApp e e-mail também recebem o resumo preenchido após preparar a solicitação.

## Publicação no GitHub Pages

O site é estático e pode ser publicado a partir da branch `main`, pasta `/ (root)`, em Settings → Pages → Deploy from a branch. O proprietário autorizou usar o GitHub Pages gratuito, com este repositório público. A mudança para público e a ativação inicial do Pages devem ser feitas pelo proprietário em Settings quando a integração não tiver permissão para administrar essas configurações; essa autorização não prova que a mudança já foi aplicada. Depois de tornar o repositório público, selecione Deploy from a branch → main → / (root) → Save em Settings → Pages. O arquivo `.nojekyll` dispensa processamento por Jekyll. A vitrine não requer build nem segredos para publicar. Credenciais administrativas e dados dos clientes ficam somente no servidor da API, fora do repositório.

A publicação deve ser confirmada pelo status do GitHub Pages e por uma requisição ao endereço público, incluindo HTML, CSS e JavaScript. Salvar ou publicar a configuração do ambiente Codex é uma operação separada da publicação do site.
