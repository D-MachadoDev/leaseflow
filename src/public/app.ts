/**
 * LeaseFlow — Lease Ledger console.
 * Plain browser module: no imports/exports — the server transpiles this exact
 * file and serves it as /app.js.
 */

// ---------- API contract types ----------

interface ApiErrorBody { error: { code: string; message: string } }
interface HealthResponse { status: string; time: string }

interface Summary {
  currency: string;
  expectedTotal: number;
  collectedTotal: number;
  pendingVerificationTotal: number;
  overdueTotal: number;
  collectionRate: number;
}

type ChargeStatus = 'PENDING' | 'PARTIAL' | 'PENDING_VERIFICATION' | 'PAID' | 'OVERDUE';
type PaymentStatus = 'PENDING_CONFIRMATION' | 'CONFIRMED';
type ContractStatus = 'ACTIVE' | 'ENDED';
type LoadState = 'loading' | 'ready' | 'error';

interface Payment {
  id: string; amount: number; reference: string;
  status: PaymentStatus; createdAt: string; confirmedAt: string | null;
}

interface ChargeView {
  id: string; contractId: string; propertyName: string; tenantName: string;
  period: string; expectedAmount: number; paidAmount: number; remaining: number;
  dueDate: string; status: ChargeStatus; payments: Payment[];
}

interface Contract {
  id: string; propertyName: string; tenantName: string; monthlyRent: number;
  paymentDayOfMonth: number; startDate: string; status: ContractStatus;
  chargeCount: number; overdueCount: number;
}

interface MutationResult { payment: Payment; charge: ChargeView }
interface GenerateResult { created: number; skipped: number; period: string }

interface State {
  currency: string;
  summary: Summary | null;
  summaryError: string | null;
  charges: ChargeView[];
  chargesState: LoadState;
  chargesError: string | null;
  contracts: Contract[];
  contractsState: LoadState;
  contractsError: string | null;
  filters: { status: string; period: string };
  expanded: Set<string>;
}

// ---------- Constants and state ----------

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CHARGE_COLUMNS = 8;
const CONTRACT_COLUMNS = 7;

const CHARGE_STATUS_LABELS: Record<ChargeStatus, string> = {
  PENDING: 'Pending',
  PARTIAL: 'Partial',
  PENDING_VERIFICATION: 'Pending verification',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
};

const CHARGE_STATUS_CLASSES: Record<ChargeStatus, string> = {
  PENDING: 'badge--pending',
  PARTIAL: 'badge--partial',
  PENDING_VERIFICATION: 'badge--verifying',
  PAID: 'badge--paid',
  OVERDUE: 'badge--overdue',
};

const state: State = {
  currency: 'COP',
  summary: null,
  summaryError: null,
  charges: [],
  chargesState: 'loading',
  chargesError: null,
  contracts: [],
  contractsState: 'loading',
  contractsError: null,
  filters: { status: '', period: '' },
  expanded: new Set<string>(),
};

const moneyFormatters = new Map<string, Intl.NumberFormat>();
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
});
const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
});

// ---------- Utilities ----------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function escapeHtml(value: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, (char) => map[char] ?? char);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error. Please try again.';
}

function formatMoney(value: number, currency: string = state.currency): string {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 });
    } catch {
      return `${currency} ${Math.round(value).toLocaleString('en-US')}`;
    }
    moneyFormatters.set(currency, formatter);
  }
  return formatter.format(value);
}

function toDate(iso: string): Date | null {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(iso: string): string {
  const parsed = toDate(iso);
  return parsed ? dateFormatter.format(parsed) : iso;
}

function formatDateTime(iso: string): string {
  const parsed = toDate(iso);
  return parsed ? dateTimeFormatter.format(parsed) : iso;
}

// ---------- API helper ----------

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function apiMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as ApiErrorBody).error;
  return error && typeof error.message === 'string' && error.message ? error.message : null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    throw new ApiError(apiMessage(body) ?? `Request failed with status ${response.status}`, response.status);
  }
  return body as T;
}

// ---------- Toasts ----------

function toast(kind: 'success' | 'error' | 'info', message: string): void {
  const container = el<HTMLDivElement>('toasts');
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;

  const text = document.createElement('p');
  text.className = 'toast-text';
  text.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '\u00D7';
  close.addEventListener('click', () => node.remove());

  node.append(text, close);
  container.append(node);
  window.setTimeout(() => node.remove(), kind === 'error' ? 9000 : 5000);
}

// ---------- Summary ----------

function renderSummary(): void {
  const status = el<HTMLParagraphElement>('summary-status');
  const summary = state.summary;

  if (!summary) {
    for (const id of ['kpi-expected', 'kpi-collected', 'kpi-pending', 'kpi-overdue', 'kpi-rate']) el(id).textContent = '—';
    el<HTMLSpanElement>('kpi-rate-fill').style.width = '0%';
    status.textContent = state.summaryError ?? 'Loading totals…';
    status.className = `section-note${state.summaryError ? ' is-error' : ''}`;
    return;
  }

  state.currency = summary.currency;
  el('kpi-expected').textContent = formatMoney(summary.expectedTotal);
  el('kpi-collected').textContent = formatMoney(summary.collectedTotal);
  el('kpi-pending').textContent = formatMoney(summary.pendingVerificationTotal);
  el('kpi-overdue').textContent = formatMoney(summary.overdueTotal);
  el('kpi-rate').textContent = `${(summary.collectionRate * 100).toFixed(1)}%`;
  el<HTMLSpanElement>('kpi-rate-fill').style.width = `${Math.max(0, Math.min(1, summary.collectionRate)) * 100}%`;
  el('kpi-rate-sub').textContent = `${formatMoney(summary.collectedTotal)} of ${formatMoney(summary.expectedTotal)} billed`;
  status.textContent = `All amounts in ${summary.currency}`;
  status.className = 'section-note';
}

// ---------- Charges ----------

function paymentItemHtml(chargeId: string, payment: Payment): string {
  const pending = payment.status === 'PENDING_CONFIRMATION';
  const badge = pending
    ? '<span class="badge badge--verifying">Awaiting confirmation</span>'
    : '<span class="badge badge--paid">Confirmed</span>';
  const confirmed = payment.confirmedAt ? `<span class="muted">Confirmed ${formatDateTime(payment.confirmedAt)}</span>` : '';

  return `<li class="payment">
    <div class="payment-main">
      <span class="payment-amount num">${formatMoney(payment.amount)}</span>
      <span class="payment-ref">${escapeHtml(payment.reference || 'No reference')}</span>
    </div>
    <div class="payment-meta">
      ${badge}
      <span class="muted">Recorded ${formatDateTime(payment.createdAt)}</span>
      ${confirmed}
    </div>
    ${
      pending
        ? `<button type="button" class="btn btn-sm btn-ok" data-action="confirm-payment" data-charge-id="${escapeHtml(
            chargeId,
          )}" data-payment-id="${escapeHtml(payment.id)}">Confirm receipt</button>`
        : ''
    }
  </li>`;
}

function paymentFormHtml(charge: ChargeView): string {
  const id = escapeHtml(charge.id);
  return `<form class="payment-form" data-form="payment" data-charge-id="${id}" novalidate>
    <p class="form-title">Record payment · ${formatMoney(charge.remaining)} remaining</p>
    <div class="field">
      <label class="field-label" for="amount-${id}">Amount (${state.currency})</label>
      <input id="amount-${id}" name="amount" type="number" min="1" step="1" inputmode="decimal" required />
    </div>
    <div class="field">
      <label class="field-label" for="reference-${id}">Reference</label>
      <input id="reference-${id}" name="reference" type="text" maxlength="60" placeholder="Transfer 8831" required />
    </div>
    <button class="btn btn-primary btn-sm" type="submit">Record payment</button>
    <p class="form-error" role="alert" hidden></p>
  </form>`;
}

function chargeRowHtml(charge: ChargeView): string {
  const id = escapeHtml(charge.id);
  const expanded = state.expanded.has(charge.id);
  const payments = charge.payments.length
    ? `<ul class="payments">${charge.payments.map((payment) => paymentItemHtml(charge.id, payment)).join('')}</ul>`
    : '<p class="muted empty-payments">No payments recorded for this charge yet.</p>';

  return `<tr class="charge-row${charge.status === 'OVERDUE' ? ' is-overdue' : ''}">
    <td class="cell-primary">
      <button type="button" class="disclosure" data-action="toggle-charge" data-charge-id="${id}"
        aria-expanded="${expanded}" aria-controls="detail-${id}">
        <span class="chevron" aria-hidden="true"></span>
        <span class="cell-stack">
          <span class="strong">${escapeHtml(charge.propertyName)}</span>
          <span class="muted">${escapeHtml(charge.tenantName)}</span>
        </span>
      </button>
    </td>
    <td class="num period">${escapeHtml(charge.period)}</td>
    <td class="num">${formatMoney(charge.expectedAmount)}</td>
    <td class="num">${formatMoney(charge.paidAmount)}</td>
    <td class="num${charge.remaining > 0 ? ' is-due' : ''}">${formatMoney(charge.remaining)}</td>
    <td class="nowrap muted">${formatDate(charge.dueDate)}</td>
    <td><span class="badge ${CHARGE_STATUS_CLASSES[charge.status]}">${CHARGE_STATUS_LABELS[charge.status]}</span></td>
    <td class="cell-actions">
      <button type="button" class="btn btn-sm btn-quiet" data-action="toggle-charge" data-charge-id="${id}">${
        expanded ? 'Close' : 'Record'
      }</button>
    </td>
  </tr>
  <tr class="detail-row" id="detail-${id}"${expanded ? '' : ' hidden'}>
    <td colspan="${CHARGE_COLUMNS}">
      <div class="detail">
        <div class="detail-col">
          <h4 class="detail-title">Payments</h4>
          ${payments}
        </div>
        <div class="detail-col">${paymentFormHtml(charge)}</div>
      </div>
    </td>
  </tr>`;
}

function messageRow(columns: number, inner: string): string {
  return `<tr class="row-message"><td colspan="${columns}">${inner}</td></tr>`;
}

function skeletonRows(columns: number): string {
  let html = '';
  for (let index = 0; index < 5; index += 1) {
    html += `<tr class="row-skeleton" aria-hidden="true"><td colspan="${columns}"><span class="skeleton"></span></td></tr>`;
  }
  return html;
}

function renderCharges(): void {
  const body = el<HTMLTableSectionElement>('charges-body');
  const note = el<HTMLParagraphElement>('charges-note');
  const { chargesState, chargesError, charges } = state;

  note.className = 'table-note';
  if (chargesState === 'loading') {
    note.textContent = 'Loading charges…';
    body.innerHTML = skeletonRows(CHARGE_COLUMNS);
    return;
  }
  if (chargesState === 'error') {
    note.textContent = 'Could not load charges.';
    note.className = 'table-note is-error';
    body.innerHTML = messageRow(
      CHARGE_COLUMNS,
      `${escapeHtml(chargesError ?? 'Unexpected error.')} <button type="button" class="btn btn-sm btn-ghost" data-action="retry-charges">Retry</button>`,
    );
    return;
  }
  if (charges.length === 0) {
    note.textContent = 'No charges for this filter.';
    body.innerHTML = messageRow(CHARGE_COLUMNS, 'No charges for this filter. Try another period, or generate the month.');
    return;
  }

  note.textContent = `${charges.length} ${charges.length === 1 ? 'charge' : 'charges'}${state.filters.period ? ` for ${state.filters.period}` : ''}`;
  body.innerHTML = charges.map(chargeRowHtml).join('');
}

// ---------- Contracts ----------

function renderContracts(): void {
  const body = el<HTMLTableSectionElement>('contracts-body');
  const note = el<HTMLParagraphElement>('contracts-status');
  const { contractsState, contractsError, contracts } = state;

  note.className = 'section-note';
  if (contractsState === 'loading') {
    note.textContent = 'Loading leases…';
    body.innerHTML = skeletonRows(CONTRACT_COLUMNS);
    return;
  }
  if (contractsState === 'error') {
    note.textContent = 'Could not load leases.';
    note.className = 'section-note is-error';
    body.innerHTML = messageRow(
      CONTRACT_COLUMNS,
      `${escapeHtml(contractsError ?? 'Unexpected error.')} <button type="button" class="btn btn-sm btn-ghost" data-action="retry-contracts">Retry</button>`,
    );
    return;
  }
  if (contracts.length === 0) {
    note.textContent = 'No leases yet.';
    body.innerHTML = messageRow(CONTRACT_COLUMNS, 'No leases registered yet.');
    return;
  }

  note.textContent = `${contracts.filter((contract) => contract.status === 'ACTIVE').length} active of ${contracts.length} leases`;
  body.innerHTML = contracts
    .map((contract) => {
      const overdue =
        contract.overdueCount > 0
          ? `<span class="badge badge--overdue">${contract.overdueCount} overdue</span>`
          : '<span class="muted">None</span>';
      const status =
        contract.status === 'ACTIVE'
          ? '<span class="badge badge--active">Active</span>'
          : '<span class="badge badge--ended">Ended</span>';
      return `<tr>
        <th scope="row" class="cell-primary">
          <span class="cell-stack">
            <span class="strong">${escapeHtml(contract.propertyName)}</span>
            <span class="muted">${escapeHtml(contract.tenantName)}</span>
          </span>
        </th>
        <td class="num">${formatMoney(contract.monthlyRent)}</td>
        <td class="num">Day ${contract.paymentDayOfMonth}</td>
        <td class="nowrap muted">${formatDate(contract.startDate)}</td>
        <td class="num">${contract.chargeCount}</td>
        <td>${overdue}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join('');
}

// ---------- Data loading ----------

async function loadSummary(): Promise<void> {
  try {
    state.summary = await api<Summary>('/api/summary');
    state.summaryError = null;
  } catch (error) {
    state.summary = null;
    state.summaryError = errorText(error);
  }
  renderSummary();
}

async function loadCharges(): Promise<void> {
  state.chargesState = 'loading';
  renderCharges();

  const params = new URLSearchParams();
  if (state.filters.status) params.set('status', state.filters.status);
  if (state.filters.period) params.set('period', state.filters.period);
  const query = params.toString();

  try {
    const data = await api<{ charges: ChargeView[] }>(`/api/charges${query ? `?${query}` : ''}`);
    state.charges = data.charges;
    state.chargesState = 'ready';
    state.chargesError = null;
  } catch (error) {
    state.chargesState = 'error';
    state.chargesError = errorText(error);
  }
  renderCharges();
}

async function loadContracts(): Promise<void> {
  state.contractsState = 'loading';
  renderContracts();
  try {
    const data = await api<{ contracts: Contract[] }>('/api/contracts');
    state.contracts = data.contracts;
    state.contractsState = 'ready';
    state.contractsError = null;
  } catch (error) {
    state.contractsState = 'error';
    state.contractsError = errorText(error);
  }
  renderContracts();
}

async function refreshLedger(): Promise<void> {
  await Promise.all([loadSummary(), loadCharges()]);
}

async function checkHealth(): Promise<void> {
  const indicator = el<HTMLSpanElement>('health-indicator');
  try {
    const health = await api<HealthResponse>('/api/health');
    indicator.textContent = `Connected · server time ${formatDateTime(health.time)}`;
    indicator.className = 'health';
  } catch {
    indicator.textContent = 'API unreachable — no live data shown.';
    indicator.className = 'health is-error';
  }
}

// ---------- User actions ----------

function toggleCharge(chargeId: string, trigger: HTMLElement): void {
  const detail = document.getElementById(`detail-${chargeId}`);
  const open = !state.expanded.has(chargeId);
  if (open) state.expanded.add(chargeId);
  else state.expanded.delete(chargeId);
  if (detail) detail.hidden = !open;

  const selector = `[data-action="toggle-charge"][data-charge-id="${chargeId}"]`;
  document.querySelectorAll<HTMLElement>(selector).forEach((button) => {
    button.setAttribute('aria-expanded', String(open));
    if (button.classList.contains('btn-quiet')) button.textContent = open ? 'Close' : 'Record';
  });
  if (open) trigger.blur();
}

async function onGenerate(): Promise<void> {
  const input = el<HTMLInputElement>('generate-period');
  const submit = el<HTMLButtonElement>('generate-submit');
  const period = input.value.trim();

  if (!PERIOD_PATTERN.test(period)) {
    toast('error', 'Enter the billing period as YYYY-MM, for example 2026-11.');
    input.focus();
    return;
  }

  submit.disabled = true;
  try {
    const result = await api<GenerateResult>('/api/charges/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period }),
    });
    toast('success', `Created ${result.created} charges, skipped ${result.skipped} for ${result.period}.`);
    state.filters.period = period;
    el<HTMLInputElement>('filter-period').value = period;
    await refreshLedger();
  } catch (error) {
    toast('error', errorText(error));
  } finally {
    submit.disabled = false;
  }
}

async function onSubmitPayment(form: HTMLFormElement): Promise<void> {
  const chargeId = form.dataset.chargeId ?? '';
  const amountInput = form.querySelector<HTMLInputElement>('input[name="amount"]');
  const referenceInput = form.querySelector<HTMLInputElement>('input[name="reference"]');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const errorBox = form.querySelector<HTMLParagraphElement>('.form-error');
  if (!amountInput || !referenceInput) return;

  const amount = Number(amountInput.value);
  const reference = referenceInput.value.trim();
  if (!Number.isFinite(amount) || amount <= 0 || reference.length === 0) {
    if (errorBox) {
      errorBox.textContent = 'Enter an amount greater than zero and a payment reference.';
      errorBox.hidden = false;
    }
    amountInput.focus();
    return;
  }

  if (errorBox) errorBox.hidden = true;
  if (submit) submit.disabled = true;
  try {
    const result = await api<MutationResult>(`/api/charges/${encodeURIComponent(chargeId)}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, reference }),
    });
    state.expanded.add(chargeId);
    toast('success', `Payment of ${formatMoney(result.payment.amount)} recorded for ${result.charge.propertyName}.`);
    await refreshLedger();
  } catch (error) {
    const message = errorText(error);
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    toast('error', message);
    if (submit) submit.disabled = false;
  }
}

async function onConfirmPayment(chargeId: string, paymentId: string, trigger: HTMLButtonElement): Promise<void> {
  trigger.disabled = true;
  try {
    const result = await api<MutationResult>(
      `/api/charges/${encodeURIComponent(chargeId)}/payments/${encodeURIComponent(paymentId)}/confirm`,
      { method: 'POST' },
    );
    toast('success', `Receipt confirmed for ${result.charge.propertyName}.`);
    await refreshLedger();
  } catch (error) {
    toast('error', errorText(error));
    trigger.disabled = false;
  }
}

function onFilterChange(): void {
  const status = el<HTMLSelectElement>('filter-status').value;
  const periodInput = el<HTMLInputElement>('filter-period');
  const period = periodInput.value.trim();

  if (period && !PERIOD_PATTERN.test(period)) {
    toast('error', 'The period filter must look like 2026-11.');
    periodInput.focus();
    return;
  }
  state.filters.status = status;
  state.filters.period = period;
  void loadCharges();
}

function onResetFilters(): void {
  el<HTMLSelectElement>('filter-status').value = '';
  el<HTMLInputElement>('filter-period').value = '';
  state.filters = { status: '', period: '' };
  void loadCharges();
}

// ---------- Wiring ----------

// Delegated listeners keep rows working after every re-render.
function onClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const trigger = target.closest<HTMLElement>('[data-action]');
  if (!trigger) return;

  const chargeId = trigger.dataset.chargeId ?? '';
  switch (trigger.dataset.action) {
    case 'toggle-charge':
      toggleCharge(chargeId, trigger);
      break;
    case 'confirm-payment':
      if (trigger instanceof HTMLButtonElement) void onConfirmPayment(chargeId, trigger.dataset.paymentId ?? '', trigger);
      break;
    case 'retry-charges':
      void loadCharges();
      break;
    case 'retry-contracts':
      void loadContracts();
      break;
    default:
      break;
  }
}

function onSubmit(event: Event): void {
  const form = event.target;
  if (form instanceof HTMLFormElement && form.dataset.form === 'payment') {
    event.preventDefault();
    void onSubmitPayment(form);
  }
}

function init(): void {
  el<HTMLFormElement>('generate-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void onGenerate();
  });
  el<HTMLSelectElement>('filter-status').addEventListener('change', onFilterChange);
  el<HTMLInputElement>('filter-period').addEventListener('change', onFilterChange);
  el<HTMLButtonElement>('filter-reset').addEventListener('click', onResetFilters);
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);

  renderSummary();
  renderCharges();
  renderContracts();
  void Promise.all([loadSummary(), loadCharges(), loadContracts()]);
  void checkHealth();
}

// Module scripts are deferred, so the shell above is already parsed.
init();
