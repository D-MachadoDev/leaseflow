import { DatabaseSync } from 'node:sqlite';
import type { Contract, ContractStatus } from '../domain/contract';
import type { Charge, Payment, PaymentStatus } from '../domain/charge';
import type { Currency } from '../domain/money';
import { Money } from '../domain/money';

// node:sqlite hands back null-prototype rows whose values are a broad union.
// Every reader below maps columns explicitly into domain objects; rows are never
// spread, so no storage detail can leak into the domain.

function toContract(row: Record<string, unknown>): Contract {
  return {
    id: String(row['id']),
    propertyName: String(row['property_name']),
    tenantName: String(row['tenant_name']),
    monthlyRent: Money.fromMinor(Number(row['rent_minor']), String(row['currency']) as Currency),
    paymentDayOfMonth: Number(row['payment_day']),
    startDate: String(row['start_date']),
    status: String(row['status']) as ContractStatus,
  };
}

function toCharge(row: Record<string, unknown>, payments: Payment[]): Charge {
  return {
    id: String(row['id']),
    contractId: String(row['contract_id']),
    period: String(row['period']),
    // Charges carry no currency of their own; it is inherited from the contract
    // via the join that produced this row.
    expectedAmount: Money.fromMinor(Number(row['expected_minor']), String(row['currency']) as Currency),
    dueDate: String(row['due_date']),
    payments,
  };
}

function toPayment(row: Record<string, unknown>): Payment {
  const confirmedAt = row['confirmed_at'];
  return {
    id: String(row['id']),
    chargeId: String(row['charge_id']),
    amount: Money.fromMinor(Number(row['amount_minor']), String(row['currency']) as Currency),
    reference: String(row['reference']),
    status: String(row['status']) as PaymentStatus,
    createdAt: String(row['created_at']),
    confirmedAt: confirmedAt === null || confirmedAt === undefined ? null : String(confirmedAt),
  };
}

export function insertContract(db: DatabaseSync, contract: Contract): void {
  db.prepare(
    `INSERT INTO contracts
       (id, property_name, tenant_name, rent_minor, currency, payment_day, start_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    contract.id,
    contract.propertyName,
    contract.tenantName,
    contract.monthlyRent.minor,
    contract.monthlyRent.currency,
    contract.paymentDayOfMonth,
    contract.startDate,
    contract.status,
  );
}

export function listContracts(db: DatabaseSync): Contract[] {
  const rows = db
    .prepare('SELECT * FROM contracts ORDER BY property_name ASC')
    .all();
  return rows.map(toContract);
}

// Payments are persisted independently of their charge, so only the charge row
// is written here.
export function insertCharge(db: DatabaseSync, charge: Charge): void {
  db.prepare(
    `INSERT INTO charges (id, contract_id, period, expected_minor, due_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    charge.id,
    charge.contractId,
    charge.period,
    charge.expectedAmount.minor,
    charge.dueDate,
  );
}

export function listCharges(db: DatabaseSync): Charge[] {
  const chargeRows = db
    .prepare(
      `SELECT ch.*, ct.currency AS currency
         FROM charges ch
         JOIN contracts ct ON ct.id = ch.contract_id
        ORDER BY ch.due_date ASC`,
    )
    .all();

  // Fetch every payment once and bucket by charge to avoid an N+1 read.
  const paymentRows = db
    .prepare(
      `SELECT p.*, ct.currency AS currency
         FROM payments p
         JOIN charges ch ON ch.id = p.charge_id
         JOIN contracts ct ON ct.id = ch.contract_id
        ORDER BY p.created_at ASC`,
    )
    .all();

  const paymentsByCharge = new Map<string, Payment[]>();
  for (const row of paymentRows) {
    const payment = toPayment(row);
    const bucket = paymentsByCharge.get(payment.chargeId);
    if (bucket) {
      bucket.push(payment);
    } else {
      paymentsByCharge.set(payment.chargeId, [payment]);
    }
  }

  return chargeRows.map((row) =>
    toCharge(row, paymentsByCharge.get(String(row['id'])) ?? []),
  );
}

export function findChargeById(db: DatabaseSync, id: string): Charge | undefined {
  const row = db
    .prepare(
      `SELECT ch.*, ct.currency AS currency
         FROM charges ch
         JOIN contracts ct ON ct.id = ch.contract_id
        WHERE ch.id = ?`,
    )
    .get(id);
  if (row === undefined) {
    return undefined;
  }

  const payments = db
    .prepare(
      `SELECT p.*, ct.currency AS currency
         FROM payments p
         JOIN charges ch ON ch.id = p.charge_id
         JOIN contracts ct ON ct.id = ch.contract_id
        WHERE p.charge_id = ?
        ORDER BY p.created_at ASC`,
    )
    .all(id)
    .map(toPayment);

  return toCharge(row, payments);
}

export function chargeExists(db: DatabaseSync, contractId: string, period: string): boolean {
  const row = db
    .prepare('SELECT 1 AS found FROM charges WHERE contract_id = ? AND period = ? LIMIT 1')
    .get(contractId, period);
  return row !== undefined;
}

export function insertPayment(db: DatabaseSync, payment: Payment): void {
  db.prepare(
    `INSERT INTO payments
       (id, charge_id, amount_minor, reference, status, created_at, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    payment.id,
    payment.chargeId,
    payment.amount.minor,
    payment.reference,
    payment.status,
    payment.createdAt,
    payment.confirmedAt,
  );
}

export function updatePaymentStatus(db: DatabaseSync, payment: Payment): void {
  db.prepare('UPDATE payments SET status = ?, confirmed_at = ? WHERE id = ?').run(
    payment.status,
    payment.confirmedAt,
    payment.id,
  );
}
