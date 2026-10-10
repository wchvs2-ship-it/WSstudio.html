'use strict';
import { studioContact, pixDetails, serviceCatalog, servicePrice, installmentPrice,
  paymentSchedule, includedServices, trafficTerms } from './catalog.js';
document.getElementById('pix-key').value = pixDetails.key;
document.getElementById('pix-holder').textContent = pixDetails.holder;
const apiConfig = window.WS_API_CONFIG || { enabled: false, baseUrl: '' };
const apiEnabled = apiConfig.enabled === true;
const apiBase = String(apiConfig.baseUrl || '').replace(/\/+$/, '');
const formFeedback = document.getElementById('order-feedback');
const submitButton = document.querySelector('#order-form [type="submit"]');
if (apiEnabled) {
  submitButton.textContent = 'Enviar solicitação ↗';
  document.getElementById('order-intro').textContent = 'Envie seus dados ao estúdio para receber uma proposta. O pagamento será combinado após a confirmação do orçamento.';
}
let requestAttempt = null;

const catalogElement = document.getElementById('service-catalog');
for (const service of serviceCatalog) {
  const card = document.createElement('article');
  card.className = `service${service.featured ? ' featured' : ''}`;
  // Content is sourced only from this local catalog, never from customer input.
  card.innerHTML = `<span class="eyebrow">${service.category}</span><h3>${service.name}</h3><p>${service.description}</p><div class="price"><span class="price-label">${service.min === service.max ? 'VALOR DO SERVIÇO' : 'FAIXA INICIAL'}</span><span>${servicePrice(service)}</span></div><p class="service-includes">${includedServices}</p><p class="service-payment">50% na contratação · 50% na entrega</p><button class="button" data-service="${service.id}" aria-label="Solicitar proposta: ${service.name}">Solicitar proposta <span>↗</span></button>`;
  catalogElement.append(card);
}
const goals={visibilidade:['VISIBILIDADE QUE ATRAVESSA DISTÂNCIAS','Seu próximo cliente pode estar procurando por você agora.','Um site apresenta seus serviços com clareza e cria uma base para aparecer nas buscas. Compartilhe um único endereço e permita que mais pessoas conheçam o seu negócio.','↗','Da sua rua para novas possibilidades.'],confianca:['UMA MARCA QUE TRANSMITE SEGURANÇA','Mostre o valor do seu trabalho antes da primeira conversa.','Apresente sua história, seus serviços e projetos reais em um espaço próprio. Uma experiência organizada ajuda o cliente a entender o que você oferece e como entrar em contato.','✳','Sua essência em cada detalhe.'],vendas:['UM CAMINHO MAIS CURTO ATÉ VOCÊ','Transforme interesse em uma próxima ação.','Facilite pedidos de orçamento, apresente soluções e direcione seus visitantes para uma conversa. Integrações de vendas e agendamento podem fazer parte de um projeto personalizado.','→','Do interesse à oportunidade.']};
document.querySelectorAll('[data-goal]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-goal]').forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});['goal-label','goal-title','goal-description','goal-icon','goal-note'].forEach((id,index)=>{document.getElementById(id).textContent=goals[button.dataset.goal][index];});}));
const projects=[['Terra & Café','Conceito para uma cafeteria: identidade acolhedora, apresentação do cardápio e caminhos claros para localização e contato. Uma ideia de como levar a atmosfera do espaço para o digital.'],['Forma Arquitetura','Conceito para um escritório de arquitetura: um portfólio que valoriza os projetos, explica o processo de trabalho e facilita pedidos de orçamento.'],['Viva Bem-estar','Conceito para um negócio de bem-estar: serviços apresentados com clareza e uma jornada de contato acolhedora. Um sistema de agendamento pode ser planejado como integração.']];
const projectDialog=document.getElementById('project-dialog');
document.querySelectorAll('[data-project]').forEach(button=>button.addEventListener('click',()=>{const project=projects[Number(button.dataset.project)];document.getElementById('project-title').textContent=project[0];document.getElementById('project-text').textContent=project[1];projectDialog.showModal();}));
document.getElementById('project-cta').addEventListener('click',()=>projectDialog.close());
document.querySelectorAll('dialog').forEach(dialog=>{dialog.querySelector('.close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});});
const orderDialog = document.getElementById('order-dialog');
const form = document.getElementById('order-form');
let selectedService = null;
let summary = '';
let formRevision = 0;

document.querySelectorAll('[data-service]').forEach(button => {
  button.addEventListener('click', () => {
    formRevision += 1;
    selectedService = serviceCatalog.find(service => service.id === button.dataset.service);
    form.reset();
    submitButton.disabled = false;
    form.removeAttribute('aria-busy');
    requestAttempt = null;
    formFeedback.textContent = '';
    document.getElementById('order-reference').textContent = '';
    document.getElementById('selected-service').value = selectedService.name;
    const details = document.getElementById('selected-service-details');
    details.textContent = `${servicePrice(selectedService)} · Entrega em média de 4 dias. ${includedServices} ${trafficTerms} ${paymentSchedule(selectedService)}`;
    form.hidden = false;
    document.getElementById('order-result').hidden = true;
    document.getElementById('pix-instructions').hidden = true;
    document.getElementById('pix-copy-status').textContent = '';
    document.getElementById('send-whatsapp').href = `https://wa.me/${studioContact.whatsapp}`;
    document.getElementById('send-email').href = `mailto:${studioContact.email}`;
    orderDialog.showModal();
  });
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedService) return;
  const submittedService = selectedService;
  const submittedRevision = formRevision;
  const currentForm = () => submittedRevision === formRevision && orderDialog.open;
  const data = new FormData(form);
  let registeredOrder = null;
  let proposalService = submittedService;
  formFeedback.textContent = '';
  if (apiEnabled) {
    const payload = JSON.stringify({
      serviceId: submittedService.id,
      name: String(data.get('name')).trim(),
      email: String(data.get('email')).trim(),
      business: String(data.get('business')).trim(),
      goal: String(data.get('goal')).trim(),
      paymentMethod: data.get('payment'),
      maintenanceRequested: data.has('maintenance')
    });
    if (!requestAttempt || requestAttempt.payload !== payload) {
      requestAttempt = { payload, key: crypto.randomUUID() };
    }
    submitButton.disabled = true;
    form.setAttribute('aria-busy', 'true');
    formFeedback.textContent = 'Registrando sua solicitação…';
    try {
      const response = await fetch(`${apiBase}/api/orders`, {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestAttempt.key },
        body: requestAttempt.payload, signal: AbortSignal.timeout(15000)
      });
      const result = await response.json();
      if (!currentForm()) return;
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Não foi possível registrar sua solicitação. Tente novamente.');
      if (typeof result.id !== 'string' || !result.estimated
        || !Number.isSafeInteger(result.estimated.minCents) || !Number.isSafeInteger(result.estimated.maxCents)) {
        throw new Error('Não foi possível confirmar o registro. Tente novamente.');
      }
      registeredOrder = result;
      proposalService = { ...submittedService, min: result.estimated.minCents, max: result.estimated.maxCents };
      formFeedback.textContent = '';
    } catch (error) {
      if (!currentForm()) return;
      formFeedback.textContent = error.name === 'TimeoutError' || error instanceof TypeError
        ? 'Não foi possível confirmar o registro. Verifique sua conexão e tente novamente.'
        : error.message;
      return;
    } finally {
      if (submittedRevision === formRevision) {
        submitButton.disabled = false;
        form.removeAttribute('aria-busy');
      }
    }
  }
  if (!currentForm()) return;
  const isPix = data.get('payment') === 'Pix';
  const pixSummary = isPix
    ? `\nPix manual — chave ${pixDetails.type.toLowerCase()}: ${pixDetails.key}\nBeneficiário: ${pixDetails.holder}\nAguarde a confirmação do orçamento antes de transferir. O recebimento será confirmado pelo estúdio.`
    : '';
  document.getElementById('pix-instructions').hidden = !isPix;
  const maintenance = data.has('maintenance')
    ? 'Tenho interesse — R$ 100,00 a R$ 150,00 por mês, conforme o projeto.'
    : 'Não solicitada neste pedido.';
  summary = `SOLICITAÇÃO DE PROPOSTA — WSstudio

Serviço: ${proposalService.name}
${proposalService.min === proposalService.max ? 'Valor do serviço' : 'Faixa inicial'}: ${servicePrice(proposalService)}
Inclusos: ${includedServices}
Tráfego pago: ${trafficTerms}
Entrega: em média, 4 dias.
Condição de pagamento: 50% na contratação e 50% na entrega.
Entrada estimada (50%): ${installmentPrice(proposalService, 'deposit')}
Quitação estimada na entrega (50%): ${installmentPrice(proposalService, 'balance')}
Manutenção mensal tratada separadamente do valor do serviço.
Preferência de pagamento: ${data.get('payment')}${pixSummary}
Manutenção mensal: ${maintenance}

Nome: ${data.get('name')}
E-mail: ${data.get('email')}
Negócio: ${data.get('business')}

Objetivo:
${data.get('goal')}

Valor final, escopo, prazo, condições da promoção e custos adicionais serão confirmados na proposta.
Esta solicitação não confirma uma compra ou pagamento.`;
  document.getElementById('order-reference').textContent = registeredOrder ? `Número do pedido: ${registeredOrder.id}` : '';
  document.getElementById('order-result-title').textContent = registeredOrder ? 'Sua solicitação foi registrada.' : 'Sua solicitação está pronta.';
  if (registeredOrder) summary = `Número do pedido: ${registeredOrder.id}\n\n${summary}`;
  document.getElementById('order-summary').textContent = summary;
  document.getElementById('send-whatsapp').href = `https://wa.me/${studioContact.whatsapp}?text=${encodeURIComponent(summary)}`;
  document.getElementById('send-email').href = `mailto:${studioContact.email}?subject=${encodeURIComponent('Solicitação de proposta — WSstudio')}&body=${encodeURIComponent(summary)}`;
  form.hidden = true;
  document.getElementById('order-result').hidden = false;
  document.getElementById('send-whatsapp').focus();
});
document.getElementById('download-order').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([summary],{type:'text/plain;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='solicitacao-wsstudio.txt';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
document.getElementById('year').textContent=new Date().getFullYear();

document.getElementById('copy-pix').addEventListener('click', async () => {
  const status = document.getElementById('pix-copy-status');
  try {
    await navigator.clipboard.writeText(pixDetails.key);
    status.textContent = 'Chave Pix copiada.';
  } catch {
    const field = document.getElementById('pix-key');
    field.focus();
    field.select();
    status.textContent = 'Selecione a chave acima e copie manualmente.';
  }
});
