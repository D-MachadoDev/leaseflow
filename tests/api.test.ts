import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/server';
import { openDatabase } from '../src/db/database';
import { seedIfEmpty } from '../src/db/seed';
import type {
  ChargeView,
  ContractView,
  DashboardSummary,
  PaymentView,
} from '../src/services/billing-service';

/**
 * Integration suite for the REST layer: the real Express app wired to a
 * seeded in-memory SQLite ledger, exercised through supertest.
 *
 * Determinism rules:
 * - Each suite boots its own database, so suites cannot leak state.
 * - Seeded charge statuses depend on the wall clock (a PARTIAL charge turns
 *   OVERDUE once its due date passes) and are therefore never asserted
 *   directly. Date-sensitive scenarios generate charges for a period ~40
 *   days out, whose due dates are guaranteed to still lie in the future.
 */

const LINDA_PROPERTY = 'Apto 502 - Linda Vista'; // seeded contract, 1850000 COP rent
const LINDA_RENT = 1850000;
const CHARGE_STATUSES = ['PENDING', 'PARTIAL', 'PENDING_VERIFICATION', 'PAID', 'OVERDUE'];

/** ~40 days out: past all seeded periods, and every due date still ahead. */
function futurePeriod(): string {
  return new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString().slice(0, 7);
}

/** Every failure must come back through the single error envelope. */
function expectErrorEnvelope(
  res: { status: number; body: unknown },
  status: number,
  code: string,
): void {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: { code, message: expect.any(String) } });
}

/** Fetches the linda contract's charge for a freshly generated period. */
async function getLindaCharge(app: Express, period: string): Promise<ChargeView> {
  const res = await request(app).get(`/api/charges?period=${period}`);
  const charge = (res.body.charges as ChargeView[]).find(
    (candidate) => candidate.propertyName === LINDA_PROPERTY && candidate.period === period,
  );
  if (!charge) {
    throw new Error(`linda charge was not generated for period ${period}`);
  }
  return charge;
}

/** Boots a private seeded in-memory app. Must be the first line of a suite. */
function useSeededApp(): { app: Express } {
  let app: Express | null = null;
  let db: DatabaseSync | null = null;
  beforeAll(() => {
    db = openDatabase(':memory:');
    seedIfEmpty(db);
    app = createApp(db);
  });
  afterAll(() => {
    db?.close();
  });
  return {
    get app(): Express {
      if (app === null) {
        throw new Error('app used before suite setup');
      }
      return app;
    },
  };
}

describe('health/summary/contracts', () => {
  const api = useSeededApp();

  it('GET /api/health reports ok with an ISO timestamp', async () => {
    const res = await request(api.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Number.isNaN(Date.parse(res.body.time))).toBe(false);
  });

  it('GET /api/summary returns COP totals and a 0..1 collection rate', async () => {
    const res = await request(api.app).get('/api/summary');
    expect(res.status).toBe(200);
    const summary = res.body as DashboardSummary;
    expect(summary.currency).toBe('COP');
    for (const field of [
      'expectedTotal',
      'collectedTotal',
      'pendingVerificationTotal',
      'overdueTotal',
    ] as const) {
      expect(typeof summary[field]).toBe('number');
      expect(summary[field]).toBeGreaterThanOrEqual(0);
    }
    expect(summary.collectionRate).toBeGreaterThanOrEqual(0);
    expect(summary.collectionRate).toBeLessThanOrEqual(1);
    // Overpayment is never accepted, so collection can never exceed expectation.
    expect(summary.collectedTotal).toBeLessThanOrEqual(summary.expectedTotal);
  });

  it('GET /api/contracts lists the seeded contracts with the full view shape', async () => {
    const res = await request(api.app).get('/api/contracts');
    expect(res.status).toBe(200);
    const contracts = res.body.contracts as ContractView[];
    expect(contracts.length).toBeGreaterThanOrEqual(4);
    // Seeded COP rents are whole pesos exposed as decimal amounts.
    expect(contracts.map((contract) => contract.monthlyRent)).toContain(LINDA_RENT);
    for (const contract of contracts) {
      expect(contract.id.length).toBeGreaterThan(0);
      expect(contract.propertyName.length).toBeGreaterThan(0);
      expect(contract.tenantName.length).toBeGreaterThan(0);
      expect(typeof contract.monthlyRent).toBe('number');
      expect(Number.isInteger(contract.monthlyRent)).toBe(true);
      expect(contract.paymentDayOfMonth).toBeGreaterThanOrEqual(1);
      expect(contract.paymentDayOfMonth).toBeLessThanOrEqual(31);
      expect(contract.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(contract.status === 'ACTIVE' || contract.status === 'ENDED').toBe(true);
      expect(typeof contract.chargeCount).toBe('number');
      expect(typeof contract.overdueCount).toBe('number');
    }
  });
});

describe('POST /api/contracts', () => {
  const api = useSeededApp();

  const validContract = () => ({
    propertyName: `Apto API Test ${randomUUID()}`, // unique per run
    tenantName: 'Inquilino API',
    monthlyRent: 1234500,
    paymentDayOfMonth: 10,
    startDate: '2026-03-01',
  });

  it('creates an ACTIVE contract and returns the 201 view with defaults', async () => {
    const input = { ...validContract(), tenantName: '  Inquilino De Prueba  ' };
    const res = await request(api.app).post('/api/contracts').send(input);
    expect(res.status).toBe(201);
    const view = res.body as ContractView;
    expect(view.id.length).toBeGreaterThan(0);
    expect(view.propertyName).toBe(input.propertyName);
    expect(view.tenantName).toBe('Inquilino De Prueba'); // names are trimmed
    expect(view.monthlyRent).toBe(1234500);
    expect(view.paymentDayOfMonth).toBe(10);
    expect(view.startDate).toBe('2026-03-01');
    expect(view.status).toBe('ACTIVE');
    expect(view.chargeCount).toBe(0);
    expect(view.overdueCount).toBe(0);

    const list = await request(api.app).get('/api/contracts');
    expect((list.body.contracts as ContractView[]).some((contract) => contract.id === view.id)).toBe(true);
  });

  it('rejects a body missing required fields', async () => {
    const res = await request(api.app).post('/api/contracts').send({ monthlyRent: 1000000 });
    expectErrorEnvelope(res, 400, 'VALIDATION');
  });

  const invalidContracts: Array<[string, Record<string, unknown>]> = [
    ['paymentDayOfMonth 32', { paymentDayOfMonth: 32 }],
    ['paymentDayOfMonth 0', { paymentDayOfMonth: 0 }],
    ['monthlyRent 0', { monthlyRent: 0 }],
    ['negative monthlyRent', { monthlyRent: -100 }],
    ['unsupported currency', { currency: 'EUR' }],
    ['shape-invalid startDate', { startDate: '01-01-2026' }],
    ['calendar-invalid startDate', { startDate: '2026-02-30' }],
  ];

  it.each(invalidContracts)('rejects %s', async (_label, override) => {
    const res = await request(api.app)
      .post('/api/contracts')
      .send({ ...validContract(), ...override });
    expectErrorEnvelope(res, 400, 'VALIDATION');
  });
});

describe('charges listing & filters', () => {
  const api = useSeededApp();

  it('lists at least the seven seeded charges with the full view shape', async () => {
    const res = await request(api.app).get('/api/charges');
    expect(res.status).toBe(200);
    const charges = res.body.charges as ChargeView[];
    expect(charges.length).toBeGreaterThanOrEqual(7);
    for (const charge of charges) {
      expect(charge.id.length).toBeGreaterThan(0);
      expect(charge.contractId.length).toBeGreaterThan(0);
      expect(charge.propertyName.length).toBeGreaterThan(0);
      expect(charge.period).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
      expect(charge.expectedAmount).toBeGreaterThan(0);
      expect(charge.paidAmount).toBeGreaterThanOrEqual(0);
      expect(charge.remaining).toBeGreaterThanOrEqual(0);
      // paid + remaining always accounts for the full expectation.
      expect(charge.paidAmount + charge.remaining).toBe(charge.expectedAmount);
      expect(charge.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(CHARGE_STATUSES).toContain(charge.status);
      expect(Array.isArray(charge.payments)).toBe(true);
    }
  });

  it('?status=PAID only returns PAID charges', async () => {
    const res = await request(api.app).get('/api/charges?status=PAID');
    expect(res.status).toBe(200);
    const charges = res.body.charges as ChargeView[];
    // Fully-confirmed seeded charges stay PAID regardless of the wall clock.
    expect(charges.length).toBeGreaterThanOrEqual(1);
    for (const charge of charges) {
      expect(charge.status).toBe('PAID');
    }
  });

  it('?period=2026-09 only returns that period', async () => {
    const res = await request(api.app).get('/api/charges?period=2026-09');
    expect(res.status).toBe(200);
    const charges = res.body.charges as ChargeView[];
    // The seed ships exactly three 2026-09 charges and this suite never writes.
    expect(charges).toHaveLength(3);
    for (const charge of charges) {
      expect(charge.period).toBe('2026-09');
    }
  });

  it('rejects an unknown status filter', async () => {
    const res = await request(api.app).get('/api/charges?status=BOGUS');
    expectErrorEnvelope(res, 400, 'VALIDATION');
  });

  it('rejects a malformed period filter', async () => {
    const res = await request(api.app).get('/api/charges?period=2026-13');
    expectErrorEnvelope(res, 400, 'VALIDATION');
  });
});

describe('generate', () => {
  const api = useSeededApp();
  const period = futurePeriod();
  let activeContracts = 0;

  it('creates one charge per ACTIVE contract: 201, skipped 0', async () => {
    const contracts = (await request(api.app).get('/api/contracts')).body.contracts as ContractView[];
    activeContracts = contracts.filter((contract) => contract.status === 'ACTIVE').length;
    expect(activeContracts).toBeGreaterThan(0);

    const res = await request(api.app).post('/api/charges/generate').send({ period });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(activeContracts);
    expect(res.body.skipped).toBe(0);
    expect(res.body.period).toBe(period);

    const charges = (await request(api.app).get(`/api/charges?period=${period}`))
      .body.charges as ChargeView[];
    expect(charges).toHaveLength(activeContracts);
    for (const charge of charges) {
      // The +40-day period guarantees future due dates, so every generated
      // charge deterministically starts PENDING, independent of today.
      expect(charge.status).toBe('PENDING');
      expect(charge.paidAmount).toBe(0);
      expect(charge.remaining).toBe(charge.expectedAmount);
    }
  });

  it('is idempotent: a second run creates nothing and skips the same contracts', async () => {
    const res = await request(api.app).post('/api/charges/generate').send({ period });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped).toBe(activeContracts);
  });

  it('rejects an invalid period', async () => {
    const res = await request(api.app).post('/api/charges/generate').send({ period: '2026-99' });
    expectErrorEnvelope(res, 400, 'VALIDATION');
  });
});

describe('payment lifecycle (future period)', () => {
  const api = useSeededApp();
  const period = futurePeriod();

  let charge: ChargeView;
  let half: number;
  let firstPaymentId = '';
  let secondPaymentId = '';
  let collectedBefore = 0;
  let pendingVerificationBefore = 0;

  beforeAll(async () => {
    const generated = await request(api.app).post('/api/charges/generate').send({ period });
    expect(generated.status).toBe(201);

    charge = await getLindaCharge(api.app, period);
    expect(charge.expectedAmount).toBe(LINDA_RENT);
    half = charge.expectedAmount / 2;
    expect(Number.isInteger(half)).toBe(true); // whole-peso rent, split stays exact

    const summary = (await request(api.app).get('/api/summary')).body as DashboardSummary;
    collectedBefore = summary.collectedTotal;
    pendingVerificationBefore = summary.pendingVerificationTotal;
  });

  it('registers a partial payment: 201, PARTIAL, half covered', async () => {
    const res = await request(api.app)
      .post(`/api/charges/${charge.id}/payments`)
      .send({ amount: half, reference: 'TRX-API-HALF' });
    expect(res.status).toBe(201);
    const { payment, charge: view } = res.body as { payment: PaymentView; charge: ChargeView };
    firstPaymentId = payment.id;
    expect(payment.amount).toBe(half);
    expect(payment.status).toBe('PENDING_CONFIRMATION');
    expect(payment.confirmedAt).toBeNull();
    expect(view.payments.some((entry) => entry.id === firstPaymentId)).toBe(true);
    expect(view.status).toBe('PARTIAL');
    expect(view.paidAmount).toBe(half);
    expect(view.remaining).toBe(LINDA_RENT - half);
  });

  it('locks the charge at PENDING_VERIFICATION once the full amount is registered', async () => {
    const res = await request(api.app)
      .post(`/api/charges/${charge.id}/payments`)
      .send({ amount: LINDA_RENT - half, reference: 'TRX-API-REST' });
    expect(res.status).toBe(201);
    const { payment, charge: view } = res.body as { payment: PaymentView; charge: ChargeView };
    secondPaymentId = payment.id;
    expect(view.status).toBe('PENDING_VERIFICATION');
    expect(view.paidAmount).toBe(LINDA_RENT);
    expect(view.remaining).toBe(0);

    const summary = (await request(api.app).get('/api/summary')).body as DashboardSummary;
    expect(summary.pendingVerificationTotal).toBe(pendingVerificationBefore + LINDA_RENT);
  });

  it('rejects a third payment while locked: 409 CONFLICT', async () => {
    const res = await request(api.app)
      .post(`/api/charges/${charge.id}/payments`)
      .send({ amount: 1, reference: 'TRX-API-EXTRA' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/locked/i);
  });

  it('confirming the first receipt keeps the charge PENDING_VERIFICATION', async () => {
    const res = await request(api.app)
      .post(`/api/charges/${charge.id}/payments/${firstPaymentId}/confirm`);
    expect(res.status).toBe(200);
    const { payment, charge: view } = res.body as { payment: PaymentView; charge: ChargeView };
    expect(payment.id).toBe(firstPaymentId);
    expect(payment.status).toBe('CONFIRMED');
    expect(payment.confirmedAt).not.toBeNull();
    expect(view.status).toBe('PENDING_VERIFICATION');
  });

  it('confirming the second receipt settles the charge and the collection total', async () => {
    const res = await request(api.app)
      .post(`/api/charges/${charge.id}/payments/${secondPaymentId}/confirm`);
    expect(res.status).toBe(200);
    const { payment, charge: view } = res.body as { payment: PaymentView; charge: ChargeView };
    expect(payment.status).toBe('CONFIRMED');
    expect(view.status).toBe('PAID');
    expect(view.paidAmount).toBe(LINDA_RENT);
    expect(view.remaining).toBe(0);

    const summary = (await request(api.app).get('/api/summary')).body as DashboardSummary;
    expect(summary.collectedTotal).toBe(collectedBefore + LINDA_RENT);
  });

  it('rejects confirming an already verified receipt: 409 CONFLICT', async () => {
    const res = await request(api.app)
      .post(`/api/charges/${charge.id}/payments/${firstPaymentId}/confirm`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/already confirmed/i);
  });

  it('returns 404 NOT_FOUND for an unknown payment on a real charge', async () => {
    const res = await request(api.app)
      .post(`/api/charges/${charge.id}/payments/pay_does_not_exist/confirm`);
    expectErrorEnvelope(res, 404, 'NOT_FOUND');
  });
});

describe('payment validation & errors', () => {
  const api = useSeededApp();
  const period = futurePeriod();

  let charge: ChargeView;

  beforeAll(async () => {
    const generated = await request(api.app).post('/api/charges/generate').send({ period });
    expect(generated.status).toBe(201);
    // Fresh charge: every rejection below must also leave it untouched.
    charge = await getLindaCharge(api.app, period);
  });

  it('rejects overpayment naming the remaining balance', async () => {
    const res = await request(api.app)
      .post(`/api/charges/${charge.id}/payments`)
      .send({ amount: charge.expectedAmount + 500, reference: 'TRX-API-OVER' });
    expectErrorEnvelope(res, 400, 'VALIDATION');
    expect(res.body.error.message).toMatch(/remaining balance/i);
  });

  it('rejects a zero amount', async () => {
    const res = await request(api.app)
      .post(`/api/charges/${charge.id}/payments`)
      .send({ amount: 0, reference: 'TRX-API-ZERO' });
    expectErrorEnvelope(res, 400, 'VALIDATION');
  });

  it('rejects a blank reference', async () => {
    const res = await request(api.app)
      .post(`/api/charges/${charge.id}/payments`)
      .send({ amount: 1000, reference: '   ' });
    expectErrorEnvelope(res, 400, 'VALIDATION');
  });

  it('returns 404 NOT_FOUND for a payment on an unknown charge', async () => {
    const res = await request(api.app)
      .post('/api/charges/missing-charge-id/payments')
      .send({ amount: 1000, reference: 'TRX-API-GHOST' });
    expectErrorEnvelope(res, 404, 'NOT_FOUND');
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await request(api.app)
      .post('/api/charges/generate')
      .set('Content-Type', 'application/json')
      .send('{"period": "oops');
    expectErrorEnvelope(res, 400, 'VALIDATION');
  });

  it('returns the 404 envelope for unknown /api routes', async () => {
    const res = await request(api.app).get('/api/nope');
    expectErrorEnvelope(res, 404, 'NOT_FOUND');
    expect(res.body.error.message).toMatch(/Unknown API route/);
  });
});
