'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const elements = Object.fromEntries([
    'global-status', 'login-section', 'login-form', 'login-error', 'username', 'password',
    'session-tools', 'session-user', 'logout', 'orders-section', 'orders-status', 'orders-body',
    'orders-table-wrap', 'table-hint', 'empty-state', 'pagination', 'previous-page', 'next-page', 'page-label',
    'refresh', 'order-dialog', 'detail-title', 'detail-status', 'detail-fields', 'close-detail',
    'payment-summary', 'payment-cards', 'quote-section', 'quote-form', 'quote-amount', 'quote-notes',
    'quote-preview', 'action-section', 'order-actions', 'order-history', 'confirm-dialog',
    'confirm-title', 'confirm-description', 'confirm-form', 'confirm-error', 'close-confirm',
    'cancel-confirm', 'confirm-submit', 'bank-confirmation', 'payment-reference', 'bank-checked',
    'action-notes'
  ].map(id => [id, $(id)]));
  const state = { csrf: null, orders: [], page: 1, limit: 20, total: 0, selected: null, action: null, expectedAmountCents: null, loading: false, mutating: false, requestId: 0 };
  const statusLabels = { new: 'Novo pedido', quoted: 'Orçamento definido', in_progress: 'Em produção', delivered: 'Entregue · saldo pendente', completed: 'Concluído', cancelled: 'Cancelado' };
  const actionLabels = { created: 'Pedido recebido', create: 'Pedido recebido', quote: 'Orçamento definido', quoted: 'Orçamento definido', deposit: 'Entrada confirmada', deliver: 'Entrega registrada', balance: 'Saldo confirmado', cancel: 'Pedido cancelado' };
  const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const dates = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
  const money = cents => Number.isSafeInteger(cents) ? currency.format(cents / 100) : 'A definir';
  const date = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Data indisponível' : dates.format(parsed);
  };
  const node = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text !== undefined && text !== null) item.textContent = String(text);
    if (className) item.className = className;
    return item;
  };
  const message = (target, value = '', kind = '') => {
    target.textContent = value;
    target.className = ['message', kind].filter(Boolean).join(' ');
    target.hidden = !value;
  };
  function setBusy(form, busy) {
    for (const control of form.querySelectorAll('input, textarea, button')) control.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
  }
  function toCents(value) {
    const match = /^(\d{1,8})(?:[,.](\d{1,2}))?$/.exec(value.trim());
    if (!match) return null;
    const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(cents) && cents >= 2 && cents <= 100_000_000 ? cents : null;
  }
  function centsInput(cents) {
    return Number.isSafeInteger(cents) ? `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}` : '';
  }
  function closeDialogs() {
    if (elements['confirm-dialog'].open) elements['confirm-dialog'].close();
    if (elements['order-dialog'].open) elements['order-dialog'].close();
  }
  function showLogin(text = '') {
    state.csrf = null;
    state.orders = [];
    state.selected = null;
    state.action = null;
    state.expectedAmountCents = null;
    state.loading = false;
    state.requestId++;
    closeDialogs();
    elements['orders-body'].replaceChildren();
    elements['detail-fields'].replaceChildren();
    elements['payment-cards'].replaceChildren();
    elements['order-history'].replaceChildren();
    elements['session-user'].textContent = '';
    elements['detail-title'].textContent = '';
    elements['payment-summary'].textContent = '';
    elements['confirm-title'].textContent = '';
    elements['confirm-description'].textContent = '';
    elements['order-actions'].replaceChildren();
    elements['quote-form'].reset();
    elements['confirm-form'].reset();
    elements['session-tools'].hidden = true;
    elements['orders-section'].hidden = true;
    elements['login-section'].hidden = false;
    elements.password.value = '';
    message(elements['global-status'], text);
    elements.username.focus();
  }
  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
    if (options.csrf) headers['X-CSRF-Token'] = state.csrf || '';
    let response;
    try {
      response = await fetch(`/api/admin${path}`, { method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    } catch {
      throw new Error('Não foi possível conectar ao servidor. Confira sua conexão e tente novamente.');
    }
    let body;
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok) {
      if (response.status === 401 && path !== '/login') {
        showLogin(state.csrf ? 'Sua sessão expirou. Entre novamente para continuar.' : '');
        const error = new Error('Sua sessão expirou. Entre novamente.');
        error.expired = true;
        throw error;
      }
      const detail = typeof body.error === 'string' ? body.error : body.error?.message || body.message;
      const error = new Error(detail || (response.status === 429 ? 'Muitas tentativas. Aguarde um pouco e tente novamente.' : 'Não foi possível concluir a operação. Tente novamente.'));
      error.status = response.status;
      throw error;
    }
    return body;
  }
  function renderOrders() {
    elements['orders-body'].replaceChildren();
    elements['orders-table-wrap'].hidden = !state.orders.length;
    elements['table-hint'].hidden = !state.orders.length;
    elements['empty-state'].hidden = !!state.orders.length;
    for (const order of state.orders) {
      const row = node('tr');
      const customer = node('td');
      customer.append(node('strong', order.customer?.name || 'Cliente'), node('small', order.id));
      const status = node('td');
      status.append(node('span', statusLabels[order.status] || order.status, `status-tag status-${Object.hasOwn(statusLabels, order.status) ? order.status : 'new'}`));
      const controls = node('td');
      const view = node('button', 'Ver pedido ↗', 'button secondary');
      view.type = 'button';
      view.setAttribute('aria-label', `Ver pedido de ${order.customer?.name || 'cliente'}`);
      view.addEventListener('click', () => openOrder(order));
      controls.append(view);
      row.append(customer, node('td', order.serviceName), node('td', date(order.createdAt)), status, node('td', order.quote ? money(order.quote.amountCents) : 'A definir'), controls);
      elements['orders-body'].append(row);
    }
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    elements['pagination'].hidden = state.total === 0;
    elements['page-label'].textContent = `Página ${state.page} de ${pages} · ${state.total} ${state.total === 1 ? 'pedido' : 'pedidos'}`;
    elements['previous-page'].disabled = state.loading || state.page <= 1;
    elements['next-page'].disabled = state.loading || state.page >= pages;
  }
  async function loadOrders({ preserveMessage = false } = {}) {
    if (!state.csrf) return;
    const requestId = ++state.requestId;
    state.loading = true;
    elements.refresh.disabled = true;
    elements['previous-page'].disabled = true;
    elements['next-page'].disabled = true;
    elements['orders-section'].setAttribute('aria-busy', 'true');
    if (!preserveMessage) message(elements['orders-status'], 'Atualizando pedidos…');
    try {
      const result = await api(`/orders?page=${state.page}&limit=${state.limit}`);
      if (requestId !== state.requestId || !state.csrf) return false;
      state.orders = Array.isArray(result.orders) ? result.orders : [];
      state.total = Number.isSafeInteger(result.total) ? result.total : state.orders.length;
      state.page = Number.isSafeInteger(result.page) ? result.page : state.page;
      state.limit = Number.isSafeInteger(result.limit) && result.limit > 0 ? result.limit : state.limit;
      if (state.page > 1 && state.orders.length === 0 && state.total > 0) {
        state.page = Math.max(1, Math.ceil(state.total / state.limit));
        return await loadOrders({ preserveMessage });
      }
      if (!preserveMessage) message(elements['orders-status'], `Pedidos atualizados às ${date(new Date())}.`);
      state.loading = false;
      renderOrders();
      return true;
    } catch (error) {
      if (!error.expired && requestId === state.requestId) message(elements['orders-status'], error.message, 'error');
      return false;
    } finally {
      if (requestId === state.requestId) {
        state.loading = false;
        elements.refresh.disabled = false;
        elements['orders-section'].setAttribute('aria-busy', 'false');
        const pages = Math.max(1, Math.ceil(state.total / state.limit));
        elements['previous-page'].disabled = state.page <= 1;
        elements['next-page'].disabled = state.page >= pages;
      }
    }
  }
  function addField(label, value, wide = false) {
    const field = node('div', null, wide ? 'field wide' : 'field');
    field.append(node('dt', label), node('dd', value || 'Não informado'));
    elements['detail-fields'].append(field);
  }
  function paymentCard(label, amount, payment) {
    const card = node('div', null, 'payment-card');
    card.append(node('p', label, 'payment-label'), node('strong', money(amount)));
    if (payment) {
      card.append(node('p', `Recebimento confirmado em ${date(payment.confirmedAt)}.`));
      card.append(node('p', `Referência: ${payment.reference || 'Não informada'}`));
    } else card.append(node('p', 'Recebimento ainda não confirmado.'));
    return card;
  }
  function renderDetails(order) {
    state.selected = order;
    elements['detail-title'].textContent = order.customer?.name || 'Detalhes do pedido';
    elements['detail-fields'].replaceChildren();
    addField('Pedido', order.id, true);
    addField('Situação', statusLabels[order.status] || order.status);
    addField('Recebido em (horário de Brasília)', date(order.createdAt));
    addField('E-mail', order.customer?.email);
    addField('Negócio', order.customer?.business);
    addField('Serviço', order.serviceName);
    addField('Preferência de pagamento', order.paymentMethod);
    addField('Faixa estimada do serviço', order.estimated ? (order.estimated.minCents === order.estimated.maxCents ? money(order.estimated.minCents) : `${money(order.estimated.minCents)} a ${money(order.estimated.maxCents)}`) : 'A definir');
    addField('Manutenção mensal', order.maintenanceRequested ? 'Solicitada · R$ 100,00 a R$ 150,00/mês, cobrada separadamente.' : 'Não solicitada');
    addField('Objetivo do cliente', order.customer?.goal, true);
    if (order.quote?.notes) addField('Condições do orçamento', order.quote.notes, true);
    elements['payment-summary'].textContent = order.quote ? `Total do serviço: ${money(order.quote.amountCents)}. 50% na contratação e 50% na entrega.` : 'O valor final e as parcelas serão definidos no orçamento. 50% na contratação e 50% na entrega.';
    elements['payment-cards'].replaceChildren(paymentCard('Entrada · contratação', order.quote?.depositCents, order.payments?.deposit), paymentCard('Saldo · entrega', order.quote?.balanceCents, order.payments?.balance));
    const editableQuote = ['new', 'quoted'].includes(order.status) && !order.payments?.deposit;
    elements['quote-section'].hidden = !editableQuote;
    elements['quote-amount'].value = centsInput(order.quote?.amountCents);
    elements['quote-notes'].value = order.quote?.notes || '';
    previewQuote();
    elements['order-actions'].replaceChildren();
    const actions = [];
    if (order.status === 'quoted' && order.quote && !order.payments?.deposit) actions.push(['deposit', 'Confirmar entrada recebida']);
    if (order.status === 'in_progress') actions.push(['deliver', 'Registrar entrega']);
    if (order.status === 'delivered' && !order.payments?.balance) actions.push(['balance', 'Confirmar saldo recebido']);
    if (['new', 'quoted'].includes(order.status) && !order.payments?.deposit) actions.push(['cancel', 'Cancelar pedido']);
    for (const [action, label] of actions) {
      const button = node('button', label, action === 'cancel' ? 'button secondary danger' : 'button');
      button.type = 'button';
      button.addEventListener('click', () => openConfirmation(action));
      elements['order-actions'].append(button);
    }
    elements['action-section'].hidden = actions.length === 0;
    elements['order-history'].replaceChildren();
    for (const event of order.history || []) {
      const entry = node('li');
      entry.append(node('span', actionLabels[event.action] || event.action), node('small', date(event.at)));
      if (event.notes) entry.append(node('p', event.notes));
      if (event.reference) entry.append(node('p', `Referência: ${event.reference}`));
      elements['order-history'].append(entry);
    }
    if (!order.history?.length) elements['order-history'].append(node('li', 'Nenhum registro adicional.'));
  }
  function openOrder(order) {
    message(elements['detail-status']);
    renderDetails(order);
    elements['order-dialog'].showModal();
  }
  function previewQuote() {
    const cents = toCents(elements['quote-amount'].value);
    elements['quote-amount'].setCustomValidity('');
    elements['quote-preview'].hidden = cents === null;
    if (cents !== null) {
      const deposit = Math.ceil(cents / 2);
      elements['quote-preview'].textContent = `Entrada: ${money(deposit)} · Saldo na entrega: ${money(cents - deposit)}`;
    } else elements['quote-preview'].textContent = '';
  }
  function openConfirmation(action) {
    const order = state.selected;
    if (!order || state.mutating) return;
    state.action = action;
    elements['confirm-form'].reset();
    message(elements['confirm-error']);
    const payment = ['deposit', 'balance'].includes(action);
    state.expectedAmountCents = payment ? (action === 'deposit' ? order.quote?.depositCents : order.quote?.balanceCents) : null;
    elements['bank-confirmation'].hidden = !payment;
    elements['payment-reference'].required = payment;
    elements['bank-checked'].required = payment;
    elements['confirm-submit'].textContent = payment ? 'Registrar recebimento' : action === 'deliver' ? 'Confirmar entrega' : 'Cancelar pedido';
    elements['confirm-submit'].className = action === 'cancel' ? 'button secondary danger' : 'button';
    if (payment) {
      const amount = state.expectedAmountCents;
      elements['confirm-title'].textContent = action === 'deposit' ? 'Confirmar entrada' : 'Confirmar saldo';
      elements['confirm-description'].textContent = `Confira no banco o recebimento de ${money(amount)} de ${order.customer?.name || 'cliente'}. Este registro é manual e só deve ser feito após verificar que o valor entrou na conta.`;
    } else if (action === 'deliver') {
      elements['confirm-title'].textContent = 'Registrar entrega';
      elements['confirm-description'].textContent = 'Confirme que o serviço foi entregue ao cliente. O pedido ficará aguardando a confirmação do saldo.';
    } else {
      elements['confirm-title'].textContent = 'Cancelar pedido';
      elements['confirm-description'].textContent = 'Confirme o cancelamento deste pedido. Esta ação ficará registrada no histórico.';
    }
    elements['confirm-dialog'].showModal();
  }
  async function mutate(body, source) {
    if (!state.selected || state.mutating || !state.csrf) return false;
    const orderId = state.selected.id;
    state.mutating = true;
    setBusy(elements['quote-form'], true);
    setBusy(elements['confirm-form'], true);
    for (const control of elements['order-actions'].querySelectorAll('button')) control.disabled = true;
    elements['close-detail'].disabled = true;
    elements['close-confirm'].disabled = true;
    message(source, 'Salvando…');
    try {
      const result = await api(`/orders/${encodeURIComponent(orderId)}`, { method: 'PATCH', csrf: true, body });
      if (!state.csrf) return false;
      const updated = result.order || (result.id ? result : null);
      if (elements['confirm-dialog'].open) elements['confirm-dialog'].close();
      if (updated) {
        state.orders = state.orders.map(order => order.id === orderId ? updated : order);
        renderOrders();
      }
      const refreshed = await loadOrders({ preserveMessage: true });
      if (!state.csrf) return false;
      const fresh = updated || state.orders.find(order => order.id === orderId);
      if (fresh) renderDetails(fresh);
      else if (elements['order-dialog'].open) elements['order-dialog'].close();
      message(elements['detail-status'], 'Pedido atualizado. O registro foi salvo no histórico.', 'success');
      if (refreshed) message(elements['orders-status'], 'Pedido atualizado.', 'success');
      return true;
    } catch (error) {
      if (error.status === 409 && ['deposit', 'balance'].includes(body.action)) {
        if (elements['confirm-dialog'].open) elements['confirm-dialog'].close();
        const refreshed = await loadOrders({ preserveMessage: true });
        if (!state.csrf) return false;
        const fresh = refreshed ? state.orders.find(order => order.id === orderId) : null;
        if (fresh) renderDetails(fresh);
        const instructions = fresh ? 'O pedido foi atualizado. Confira o valor no banco novamente antes de abrir uma nova confirmação.' : 'Feche os detalhes, atualize a lista e confira o valor no banco antes de abrir uma nova confirmação.';
        message(elements['detail-status'], `${error.message} O recebimento não foi registrado. ${instructions}`, 'error');
      } else if (!error.expired) message(source, error.message, 'error');
      return false;
    } finally {
      state.mutating = false;
      setBusy(elements['quote-form'], false);
      setBusy(elements['confirm-form'], false);
      elements['close-detail'].disabled = false;
      elements['close-confirm'].disabled = false;
      for (const control of elements['order-actions'].querySelectorAll('button')) control.disabled = false;
    }
  }
  function authenticated(session) {
    state.csrf = session.csrfToken;
    state.page = 1;
    elements['session-user'].textContent = session.username || 'Administrador';
    elements['session-tools'].hidden = false;
    elements['login-section'].hidden = true;
    elements['orders-section'].hidden = false;
    message(elements['login-error']);
    message(elements['global-status']);
    elements.password.value = '';
    loadOrders();
  }
  elements['login-form'].addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(elements['login-form'], true);
    message(elements['login-error']);
    try {
      const session = await api('/login', { method: 'POST', body: { username: elements.username.value.trim(), password: elements.password.value } });
      if (!session.csrfToken) throw new Error('Não foi possível iniciar a sessão. Tente novamente.');
      authenticated(session);
      elements.refresh.focus();
    } catch (error) {
      message(elements['login-error'], error.message, 'error');
    } finally {
      elements.password.value = '';
      setBusy(elements['login-form'], false);
    }
  });
  elements.logout.addEventListener('click', async () => {
    if (state.mutating) return;
    elements.logout.disabled = true;
    try {
      await api('/logout', { method: 'POST', csrf: true });
      showLogin('Você saiu do painel.');
    } catch (error) {
      if (!error.expired) message(elements['orders-status'], `Não foi possível encerrar a sessão: ${error.message}`, 'error');
    } finally { elements.logout.disabled = false; }
  });
  elements.refresh.addEventListener('click', () => loadOrders());
  elements['previous-page'].addEventListener('click', () => { if (!state.loading && state.page > 1) { state.page--; loadOrders(); } });
  elements['next-page'].addEventListener('click', () => { if (!state.loading && state.page * state.limit < state.total) { state.page++; loadOrders(); } });
  elements['close-detail'].addEventListener('click', () => { if (!state.mutating) elements['order-dialog'].close(); });
  elements['close-confirm'].addEventListener('click', () => { if (!state.mutating) elements['confirm-dialog'].close(); });
  elements['cancel-confirm'].addEventListener('click', () => { if (!state.mutating) elements['confirm-dialog'].close(); });
  for (const dialog of [elements['order-dialog'], elements['confirm-dialog']]) dialog.addEventListener('cancel', event => { if (state.mutating) event.preventDefault(); });
  elements['order-dialog'].addEventListener('close', () => {
    state.selected = null;
    elements['detail-fields'].replaceChildren();
    elements['payment-cards'].replaceChildren();
    elements['order-history'].replaceChildren();
    elements['quote-form'].reset();
  });
  elements['confirm-dialog'].addEventListener('close', () => { state.action = null; state.expectedAmountCents = null; elements['confirm-form'].reset(); });
  elements['quote-amount'].addEventListener('input', previewQuote);
  elements['quote-form'].addEventListener('submit', async event => {
    event.preventDefault();
    const amountCents = toCents(elements['quote-amount'].value);
    if (amountCents === null) {
      elements['quote-amount'].setCustomValidity('Informe um valor de R$ 0,02 a R$ 1.000.000,00, como 490,90, sem separador de milhares.');
      elements['quote-amount'].reportValidity();
      return;
    }
    await mutate({ action: 'quote', amountCents, notes: elements['quote-notes'].value.trim() }, elements['detail-status']);
  });
  elements['confirm-form'].addEventListener('submit', async event => {
    event.preventDefault();
    const action = state.action;
    if (!action) return;
    const body = { action, notes: elements['action-notes'].value.trim() };
    if (['deposit', 'balance'].includes(action)) {
      body.reference = elements['payment-reference'].value.trim();
      body.expectedAmountCents = state.expectedAmountCents;
      if (!Number.isSafeInteger(body.expectedAmountCents) || body.expectedAmountCents <= 0) {
        message(elements['confirm-error'], 'Atualize o pedido e confira o valor antes de registrar o recebimento.', 'error');
        return;
      }
      if (!body.reference || !elements['bank-checked'].checked) {
        message(elements['confirm-error'], 'Informe a referência e confirme que conferiu o recebimento no banco.', 'error');
        return;
      }
    }
    await mutate(body, elements['confirm-error']);
  });
  (async () => {
    try {
      const session = await api('/session');
      if (!session.csrfToken) throw new Error('A sessão não pôde ser carregada. Entre novamente.');
      authenticated(session);
    } catch (error) {
      if (!error.expired) showLogin(error.message);
    }
  })();
})();
