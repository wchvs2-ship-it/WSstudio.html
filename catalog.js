export const studioContact={whatsapp:'5586994911357',email:'wcstudio.sites@gmail.com'};
export const pixDetails = { type: 'Celular', key: '+5586981579130', holder: 'William Carvalho do Nascimento' };
export const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const serviceCatalog = [
  { id: 'landing', name: 'Landing page comum', min: 49090, max: 59090,
    category: '01 / PRESENÇA', description: 'Uma página para apresentar sua oferta e facilitar o primeiro contato.' },
  { id: 'institucional', name: 'Site institucional', min: 59090, max: 79090,
    category: '02 / IDENTIDADE DIGITAL', description: 'Um espaço para contar sua história e apresentar os serviços do seu negócio.', featured: true },
  { id: 'blog', name: 'Blog', min: 34090, max: 34090,
    category: '03 / CONTEÚDO', description: 'Compartilhe ideias e conteúdos para aproximar sua marca do seu público.' },
  { id: 'cardapio', name: 'Cardápio', min: 19090, max: 19090,
    category: '04 / GASTRONOMIA', description: 'Apresente os produtos e sabores do seu negócio em um cardápio digital.' },
  { id: 'loja', name: 'Loja virtual', min: 49090, max: 69090,
    category: '05 / VENDAS', description: 'Leve seus produtos para o digital com uma loja pensada para o seu negócio.' }
];
export function servicePrice(service) {
  const min = currency.format(service.min / 100);
  return service.min === service.max ? min : `${min} a ${currency.format(service.max / 100)}`;
}
export function splitPayment(cents) {
  const deposit = Math.round(cents / 2);
  return { deposit, balance: cents - deposit };
}
export function installmentPrice(service, part) {
  return servicePrice({
    min: splitPayment(service.min)[part],
    max: splitPayment(service.max)[part]
  });
}
export function paymentSchedule(service) {
  return `50% na contratação: ${installmentPrice(service, 'deposit')}. 50% na entrega: ${installmentPrice(service, 'balance')}. Valores estimados, confirmados na proposta.`;
}
export const includedServices = 'Domínio e hospedagem por 1 ano e uma semana de gestão de tráfego.';
export const trafficTerms = 'Tráfego pago incluído conforme a promoção e a faixa de valor contratada. Fora da promoção, é um serviço adicional sob orçamento.';
