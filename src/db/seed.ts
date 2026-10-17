import { DatabaseSync } from 'node:sqlite';
import { createContract } from '../domain/contract';
import { createCharge } from '../domain/charge';
import type { Payment, PaymentStatus } from '../domain/charge';
import { Money } from '../domain/money';
import { insertCharge, insertContract, insertPayment } from './repository';

function buildPayment(input: {
  id: string;
  chargeId: string;
  amountMinor: number;
  reference: string;
  status: PaymentStatus;
  createdAt: string;
  confirmedAt: string | null;
}): Payment {
  return {
    id: input.id,
    chargeId: input.chargeId,
    amount: Money.fromMinor(input.amountMinor, 'COP'),
    reference: input.reference,
    status: input.status,
    createdAt: input.createdAt,
    confirmedAt: input.confirmedAt,
  };
}

/**
 * Seeds a realistic ledger once. Idempotent: a database that already holds
 * contracts is left untouched, so repeated startups never duplicate data.
 *
 * The scenario spans two billing periods so every charge status the engine must
 * report is represented: PAID, PARTIAL, PENDING, OVERDUE and
 * PENDING_VERIFICATION.
 */
export function seedIfEmpty(db: DatabaseSync): void {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM contracts').get();
  if (existing !== undefined && Number(existing['count']) > 0) {
    return;
  }

  const contracts = [
    createContract({
      id: 'ctr_linda_502',
      propertyName: 'Apto 502 - Linda Vista',
      tenantName: 'Maria Fernanda Rojas',
      monthlyRent: Money.fromMinor(1850000, 'COP'),
      paymentDayOfMonth: 5,
      startDate: '2025-11-01',
    }),
    createContract({
      id: 'ctr_casa_12',
      propertyName: 'Casa 12 - Quinta El Sol',
      tenantName: 'Carlos Andres Mejia',
      monthlyRent: Money.fromMinor(2400000, 'COP'),
      paymentDayOfMonth: 1,
      startDate: '2026-01-01',
    }),
    createContract({
      // Payment day 31 exercises end-of-month clamping (Feb 28/29, Sep 30).
      id: 'ctr_studio_03',
      propertyName: 'Studio 03 - Centro Historico',
      tenantName: 'Laura Gomez',
      monthlyRent: Money.fromMinor(950000, 'COP'),
      paymentDayOfMonth: 31,
      startDate: '2026-02-01',
    }),
    createContract({
      // Mid-month due date keeps a live PARTIAL example around mid-month demos.
      id: 'ctr_local_7',
      propertyName: 'Local 7 - Plaza Mercado',
      tenantName: 'Panaderia El Trigal SAS',
      monthlyRent: Money.fromMinor(3200000, 'COP'),
      paymentDayOfMonth: 20,
      startDate: '2026-03-01',
    }),
  ];

  const charges = [
    createCharge({
      id: 'chg_202609_linda',
      contractId: 'ctr_linda_502',
      period: '2026-09',
      expectedAmount: Money.fromMinor(1850000, 'COP'),
      dueDate: '2026-09-05',
    }),
    createCharge({
      id: 'chg_202609_casa',
      contractId: 'ctr_casa_12',
      period: '2026-09',
      expectedAmount: Money.fromMinor(2400000, 'COP'),
      dueDate: '2026-09-01',
    }),
    createCharge({
      // Payment day 31 clamps to the last valid day of September.
      id: 'chg_202609_studio',
      contractId: 'ctr_studio_03',
      period: '2026-09',
      expectedAmount: Money.fromMinor(950000, 'COP'),
      dueDate: '2026-09-30',
    }),
    createCharge({
      id: 'chg_202610_linda',
      contractId: 'ctr_linda_502',
      period: '2026-10',
      expectedAmount: Money.fromMinor(1850000, 'COP'),
      dueDate: '2026-10-05',
    }),
    createCharge({
      id: 'chg_202610_casa',
      contractId: 'ctr_casa_12',
      period: '2026-10',
      expectedAmount: Money.fromMinor(2400000, 'COP'),
      dueDate: '2026-10-01',
    }),
    createCharge({
      // Payment day 31 is valid in October, so it is used as-is.
      id: 'chg_202610_studio',
      contractId: 'ctr_studio_03',
      period: '2026-10',
      expectedAmount: Money.fromMinor(950000, 'COP'),
      dueDate: '2026-10-31',
    }),
    createCharge({
      // Due later in the month, so its confirmed down payment stays PARTIAL.
      id: 'chg_202610_local',
      contractId: 'ctr_local_7',
      period: '2026-10',
      expectedAmount: Money.fromMinor(3200000, 'COP'),
      dueDate: '2026-10-20',
    }),
  ];

  const payments = [
    buildPayment({
      id: 'pay_202609_linda',
      chargeId: 'chg_202609_linda',
      amountMinor: 1850000,
      reference: 'TRF-88421-Bancolombia',
      status: 'CONFIRMED',
      createdAt: '2026-09-03T09:12:00Z',
      confirmedAt: '2026-09-04T11:30:00Z',
    }),
    buildPayment({
      // Partial transfer whose receipt is still unverified.
      id: 'pay_202609_casa',
      chargeId: 'chg_202609_casa',
      amountMinor: 800000,
      reference: 'TRF-90210-Davivienda',
      status: 'PENDING_CONFIRMATION',
      createdAt: '2026-09-03T18:45:00Z',
      confirmedAt: null,
    }),
    buildPayment({
      id: 'pay_202609_studio',
      chargeId: 'chg_202609_studio',
      amountMinor: 950000,
      reference: 'NEQUI-00912',
      status: 'CONFIRMED',
      createdAt: '2026-09-28T14:05:00Z',
      confirmedAt: '2026-09-29T08:40:00Z',
    }),
    buildPayment({
      id: 'pay_202610_linda',
      chargeId: 'chg_202610_linda',
      amountMinor: 1000000,
      reference: 'TRF-93110-Bancolombia',
      status: 'CONFIRMED',
      createdAt: '2026-10-03T10:22:00Z',
      confirmedAt: '2026-10-04T09:10:00Z',
    }),
    buildPayment({
      // Full payment awaiting verification, so the charge is not yet PAID.
      id: 'pay_202610_casa',
      chargeId: 'chg_202610_casa',
      amountMinor: 2400000,
      reference: 'NEQUI-01745',
      status: 'PENDING_CONFIRMATION',
      createdAt: '2026-10-02T20:15:00Z',
      confirmedAt: null,
    }),
    buildPayment({
      // Confirmed down payment before the due date: charge stays PARTIAL.
      id: 'pay_202610_local',
      chargeId: 'chg_202610_local',
      amountMinor: 1500000,
      reference: 'TRF-94502-Davivienda',
      status: 'CONFIRMED',
      createdAt: '2026-10-10T16:30:00Z',
      confirmedAt: '2026-10-11T09:05:00Z',
    }),
  ];

  db.exec('BEGIN');
  try {
    for (const contract of contracts) {
      insertContract(db, contract);
    }
    for (const charge of charges) {
      insertCharge(db, charge);
    }
    for (const payment of payments) {
      insertPayment(db, payment);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
