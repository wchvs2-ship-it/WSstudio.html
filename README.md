# WSstudio

Aplicação estática em português para apresentar o potencial de uma presença digital, explorar conceitos visuais e preparar solicitações de proposta.

## Executar

Na pasta `/workspace/WSstudio.html`:

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

Não requer instalação de dependências ou build. HTML, CSS e JavaScript nativos. Fontes do Google são opcionais; existem fontes locais de fallback.

## Estado do produto

Os projetos apresentados são conceitos demonstrativos, não trabalhos de clientes reais. O formulário exibe o valor e as condições do serviço escolhido, permite indicar a preferência de pagamento e o interesse em manutenção e prepara uma solicitação no navegador, disponível para download ou para continuar no WhatsApp/e-mail. O cliente revisa e confirma o envio no aplicativo escolhido. Essas escolhas não geram cobrança: o formulário não confirma compras nem processa pagamentos. Dados não são persistidos no navegador.

A contratação e o pagamento manual dependem da confirmação do orçamento e do escopo com o estúdio. Para automatizar cobranças e confirmações de pagamento, integrar um provedor de checkout. Credenciais de pagamento devem ficar no servidor, nunca no JavaScript público.

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

A chave ainda não foi verificada no banco. O cliente deve conferir o beneficiário no aplicativo bancário antes de transferir. O pagamento ocorre somente após confirmar o orçamento: 50% na contratação e 50% na entrega, com a manutenção mensal cobrada separadamente. O aplicativo não realiza cobranças automáticas nem verifica recebimentos no banco; o estúdio confirma o recebimento na conta. Não há QR code ou código Pix copia e cola gerados.

Para testar o fluxo de pagamento manual, é possível usar uma conta apta a receber Pix, incluindo Nubank. Qualquer transferência Pix movimenta dinheiro real, mesmo quando feita para teste. As telas e solicitações podem ser testadas sem transferências.

## Verificação

```sh
node --check app.js
curl --fail http://127.0.0.1:8000/
```

## Contatos do estúdio

- WhatsApp: +55 (86) 99491-1357 — https://wa.me/5586994911357
- E-mail: wcstudio.sites@gmail.com
- Instagram: @wcstudio.dev — https://www.instagram.com/wcstudio.dev/

Os links de contato aparecem no rodapé. WhatsApp e e-mail também recebem o resumo preenchido após preparar a solicitação.

## Publicação no GitHub Pages

O site é estático e pode ser publicado a partir da branch `main`, pasta `/ (root)`, em Settings → Pages → Deploy from a branch. O repositório está privado; GitHub Pages para repositórios privados depende de um plano compatível. A alternativa gratuita no GitHub Pages requer um repositório público, cuja mudança de visibilidade exige autorização do proprietário. O arquivo `.nojekyll` dispensa processamento por Jekyll. Não há build nem variáveis secretas necessárias para publicar.

A publicação deve ser confirmada pelo status do GitHub Pages e por uma requisição ao endereço público, incluindo HTML, CSS e JavaScript. Salvar ou publicar a configuração do ambiente Codex é uma operação separada da publicação do site.
