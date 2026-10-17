import { DatabaseSync } from 'node:sqlite';
import * as repo from '../db/repository';
import { addPayment, chargeTotals, confirmPayment, createCharge, evaluateStatus } from '../domain/charge';
import type { Charge, ChargeStatus, Payment, PaymentStatus } from '../domain/charge';
import { calculateDueDate, createContract } from '../domain/contract';
import type { Contract } from '../domain/contract';
import { DomainValidationError, NotFoundError } from '../domain/errors';
import { Money } from '../domain/money';
import type { Currency } from '../domain/money';

export interface ContractView {
  id: string;
  propertyName: string;
  tenantName: string;
  monthlyRent: number; // decimal
  paymentDayOfMonth: number;
  startDate: string;
  status: 'ACTIVE' | 'ENDED';
  chargeCount: number;
  overdueCount: number;
}

export interface PaymentView {
  id: string;
  amount: number;
  reference: string;
  status: PaymentStatus;
  createdAt: string;
  confirmedAt: string | null;
}

export interface ChargeView {
  id: string;
  contractId: string;
  propertyName: string;
  tenantName: string;
  period: string;
  expectedAmount: number;
  paidAmount: number;
  remaining: number;
  dueDate: string;
  status: ChargeStatus;
  payments: PaymentView[];
}

export interface DashboardSummary {
  currency: Currency;
  expectedTotal: number;
  collectedTotal: number;
  pendingVerificationTotal: number;
  overdueTotal: number;
  collectionRate: number; // 0..1
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CHARGE_STATUSES: readonly ChargeStatus[] = [
  'PENDING',
  'PARTIAL',
  'PENDING_VERIFICATION',
  'PAID',
  'OVERDUE',
];

// Billing decisions (OVERDUE cutoffs, receipt timestamps) are anchored to UTC
// so every server timezone reaches the same verdict for the same instant.
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

function indexContracts(contracts: Contract[]): Map<string, Contract> {
  return new Map(contracts.map((contract) => [contract.id, contract] as [string, Contract]));
}

function toPaymentView(payment: Payment): PaymentView {
  return {
    id: payment.id,
    amount: payment.amount.toDecimal(),
    reference: payment.reference,
    status: payment.status,
    createdAt: payment.createdAt,
    confirmedAt: payment.confirmedAt,
  };
}

function toContractView(
  contract: Contract,
  counts: { chargeCount: number; overdueCount: number },
): ContractView {
  return {
    id: contract.id,
    propertyName: contract.propertyName,
    tenantName: contract.tenantName,
    monthlyRent: contract.monthlyRent.toDecimal(),
    paymentDayOfMonth: contract.paymentDayOfMonth,
    startDate: contract.startDate,
    status: contract.status,
    chargeCount: counts.chargeCount,
    overdueCount: counts.overdueCount,
  };
}

// paidAmount counts money that has already arrived, including receipts still
// awaiting bank verification; `remaining` is what the tenant still owes.
function toChargeView(
  charge: Charge,
  contractById: Map<string, Contract>,
  todayStr: string,
): ChargeView {
  const { paid, remaining } = chargeTotals(charge);
  const contract = contractById.get(charge.contractId);
  return {
    id: charge.id,
    contractId: charge.contractId,
    propertyName: contract?.propertyName ?? '',
    tenantName: contract?.tenantName ?? '',
    period: charge.period,
    expectedAmount: charge.expectedAmount.toDecimal(),
    paidAmount: paid.toDecimal(),
    remaining: remaining.toDecimal(),
    dueDate: charge.dueDate,
    status: evaluateStatus(charge, todayStr),
    payments: charge.payments.map(toPaymentView),
  };
}

/**
 * Application service: orchestrates domain rules and persistence behind
 * serializable view models, so callers never handle Money objects,
 * aggregates or SQLite rows directly.
 */
export class BillingService {
  constructor(private readonly db: DatabaseSync) {}

  createContract(input: {
    propertyName: string;
    tenantName: string;
    monthlyRent: number; // decimal, must be > 0
    currency?: Currency; // defaults to 'COP'
    paymentDayOfMonth: number;
    startDate: string;
  }): ContractView {
    if (
      typeof input.monthlyRent !== 'number' ||
      !Number.isFinite(input.monthlyRent) ||
      input.monthlyRent <= 0
    ) {
      throw new DomainValidationError(
        `monthlyRent must be a decimal amount greater than zero, received ${String(input.monthlyRent)}`,
      );
    }
    // Domain createContract validates the remaining fields and rejects
    // unsupported currencies via Money.
    const contract = createContract({
      propertyName: input.propertyName,
      tenantName: input.tenantName,
      monthlyRent: Money.fromDecimal(input.monthlyRent, input.currency ?? 'COP'),
      paymentDayOfMonth: input.paymentDayOfMonth,
      startDate: input.startDate,
    });
    repo.insertContract(this.db, contract);
    return toContractView(contract, { chargeCount: 0, overdueCount: 0 });
  }

  listContracts(): ContractView[] {
    const todayStr = today();
    const countsById = new Map<string, { chargeCount: number; overdueCount: number }>();
    for (const charge of repo.listCharges(this.db)) {
      const counts = countsById.get(charge.contractId) ?? { chargeCount: 0, overdueCount: 0 };
      counts.chargeCount += 1;
      if (evaluateStatus(charge, todayStr) === 'OVERDUE') {
        counts.overdueCount += 1;
      }
      countsById.set(charge.contractId, counts);
    }
    const emptyCounts = { chargeCount: 0, overdueCount: 0 };
    return repo
      .listContracts(this.db)
      .map((contract) => toContractView(contract, countsById.get(contract.id) ?? emptyCounts));
  }

  generateCharges(period: string): { created: number; skipped: number } {
    if (!PERIOD_PATTERN.test(period)) {
      throw new DomainValidationError(`period must match YYYY-MM, received ${String(period)}`);
    }
    const year = Number(period.slice(0, 4));
    const month = Number(period.slice(5, 7)); // 1..12, guaranteed by the pattern
    let created = 0;
    let skipped = 0;
    for (const contract of repo.listContracts(this.db)) {
      // Only leases in force keep accruing; ended contracts are not billed.
      if (contract.status !== 'ACTIVE') {
        continue;
      }
      // One charge per contract per period: re-runs of the billing job are
      // idempotent instead of double-billing tenants.
      if (repo.chargeExists(this.db, contract.id, period)) {
        skipped += 1;
        continue;
      }
      const charge = createCharge({
        contractId: contract.id,
        period,
        expectedAmount: contract.monthlyRent,
        // Day 29/30/31 clamps to the last valid day of short months (RN-02).
        dueDate: calculateDueDate(year, month, contract.paymentDayOfMonth),
      });
      repo.insertCharge(this.db, charge);
      created += 1;
    }
    return { created, skipped };
  }

  listCharges(filter?: { status?: ChargeStatus; period?: string }): ChargeView[] {
    const wantedStatus = filter?.status;
    const wantedPeriod = filter?.period;
    // Runtime re-validation: the service is the last line of defense for
    // unchecked values that slipped past the API layer's typing.
    if (wantedStatus !== undefined && !CHARGE_STATUSES.includes(wantedStatus)) {
      throw new DomainValidationError(`Unknown charge status: ${String(wantedStatus)}`);
    }
    if (wantedPeriod !== undefined && !PERIOD_PATTERN.test(wantedPeriod)) {
      throw new DomainValidationError(
        `period must match YYYY-MM, received ${String(wantedPeriod)}`,
      );
    }
    const todayStr = today();
    const contractById = indexContracts(repo.listContracts(this.db));
    return repo
      .listCharges(this.db)
      .filter((charge) => wantedPeriod === undefined || charge.period === wantedPeriod)
      .filter((charge) => wantedStatus === undefined || evaluateStatus(charge, todayStr) === wantedStatus)
      .map((charge) => toChargeView(charge, contractById, todayStr));
  }

  registerPayment(
    chargeId: string,
    input: { amount: number; reference: string },
  ): { payment: PaymentView; charge: ChargeView } {
    const charge = repo.findChargeById(this.db, chargeId);
    if (!charge) {
      throw new NotFoundError(`Charge ${chargeId} not found`);
    }
    const amount = Money.fromDecimal(input.amount, charge.expectedAmount.currency);
    // addPayment enforces lock/overpayment/zero/reference rules on the
    // aggregate before anything is persisted.
    const payment = addPayment(
      charge,
      { amount, reference: input.reference, createdAt: nowIso() },
      today(),
    );
    repo.insertPayment(this.db, payment);
    return {
      payment: toPaymentView(payment),
      charge: toChargeView(charge, indexContracts(repo.listContracts(this.db)), today()),
    };
  }

  confirmPayment(chargeId: string, paymentId: string): { payment: PaymentView; charge: ChargeView } {
    const charge = repo.findChargeById(this.db, chargeId);
    if (!charge) {
      throw new NotFoundError(`Charge ${chargeId} not found`);
    }
    // Domain confirmPayment throws NotFoundError/ConflictError for a missing
    // or already verified receipt.
    const payment = confirmPayment(charge, paymentId, nowIso());
    repo.updatePaymentStatus(this.db, payment);
    return {
      payment: toPaymentView(payment),
      charge: toChargeView(charge, indexContracts(repo.listContracts(this.db)), today()),
    };
  }

  getSummary(): DashboardSummary {
    const todayStr = today();
    const charges = repo.listCharges(this.db);
    // Totals are summed in integer minor units and converted to decimal once,
    // so the dashboard never inherits per-row floating point drift.
    let expectedMinor = 0;
    let confirmedMinor = 0;
    let awaitingMinor = 0;
    let overdueMinor = 0;
    for (const charge of charges) {
      const totals = chargeTotals(charge);
      expectedMinor += charge.expectedAmount.minor;
      confirmedMinor += totals.confirmed.minor;
      awaitingMinor += totals.awaitingConfirmation.minor;
      if (evaluateStatus(charge, todayStr) === 'OVERDUE') {
        overdueMinor += totals.remaining.minor;
      }
    }
    // The ledger is single-currency; the first stored row defines it.
    const currency: Currency =
      charges[0]?.expectedAmount.currency ??
      repo.listContracts(this.db)[0]?.monthlyRent.currency ??
      'COP';
    return {
      currency,
      expectedTotal: Money.fromMinor(expectedMinor, currency).toDecimal(),
      collectedTotal: Money.fromMinor(confirmedMinor, currency).toDecimal(),
      pendingVerificationTotal: Money.fromMinor(awaitingMinor, currency).toDecimal(),
      overdueTotal: Money.fromMinor(overdueMinor, currency).toDecimal(),
      collectionRate: expectedMinor > 0 ? confirmedMinor / expectedMinor : 0,
    };
  }
}
