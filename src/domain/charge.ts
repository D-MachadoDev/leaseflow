import { randomUUID } from 'crypto';
import { ConflictError, DomainValidationError, NotFoundError } from './errors';
import { Money } from './money';

export type ChargeStatus = 'PENDING' | 'PARTIAL' | 'PENDING_VERIFICATION' | 'PAID' | 'OVERDUE';
export type PaymentStatus = 'PENDING_CONFIRMATION' | 'CONFIRMED';

export interface Payment {
  id: string;
  chargeId: string;
  amount: Money;
  reference: string; // bank receipt / transfer reference
  status: PaymentStatus;
  createdAt: string; // ISO datetime
  confirmedAt: string | null;
}

export interface Charge {
  id: string;
  contractId: string;
  period: string; // 'YYYY-MM'
  expectedAmount: Money;
  dueDate: string; // 'YYYY-MM-DD'
  payments: Payment[];
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = month === 2 && isLeapYear(year) ? 29 : lengths[month - 1];
  return month >= 1 && month <= 12 && day >= 1 && day <= maxDay;
}

export function createCharge(input: {
  id?: string;
  contractId: string;
  period: string;
  expectedAmount: Money;
  dueDate: string;
}): Charge {
  if (!PERIOD_PATTERN.test(input.period)) {
    throw new DomainValidationError(`period must match YYYY-MM, received ${input.period}`);
  }
  if (!isValidIsoDate(input.dueDate)) {
    throw new DomainValidationError(`dueDate must be a valid YYYY-MM-DD date: ${input.dueDate}`);
  }
  if (!input.contractId?.trim()) {
    throw new DomainValidationError('contractId is required');
  }
  const id = input.id?.trim();
  if (input.id !== undefined && !id) {
    throw new DomainValidationError('id must be a non-empty string when provided');
  }

  return {
    id: id ?? randomUUID(),
    contractId: input.contractId,
    period: input.period,
    expectedAmount: input.expectedAmount,
    dueDate: input.dueDate,
    payments: [],
  };
}

export function chargeTotals(charge: Charge): {
  confirmed: Money;
  awaitingConfirmation: Money;
  paid: Money;
  remaining: Money;
} {
  const currency = charge.expectedAmount.currency;
  let confirmed = Money.fromMinor(0, currency);
  let awaitingConfirmation = Money.fromMinor(0, currency);
  for (const payment of charge.payments) {
    if (payment.status === 'CONFIRMED') {
      confirmed = confirmed.plus(payment.amount);
    } else {
      awaitingConfirmation = awaitingConfirmation.plus(payment.amount);
    }
  }
  const paid = confirmed.plus(awaitingConfirmation);
  const remaining = Money.fromMinor(
    Math.max(0, charge.expectedAmount.minor - paid.minor),
    currency,
  );
  return { confirmed, awaitingConfirmation, paid, remaining };
}

/**
 * Single source of truth for the charge state machine (RN-03). Precedence is
 * deliberate: a fully confirmed charge is PAID even after its due date.
 */
export function evaluateStatus(charge: Charge, today: string): ChargeStatus {
  const { confirmed, awaitingConfirmation, paid } = chargeTotals(charge);
  if (confirmed.minor >= charge.expectedAmount.minor) {
    return 'PAID';
  }
  if (awaitingConfirmation.minor > 0 && paid.minor >= charge.expectedAmount.minor) {
    return 'PENDING_VERIFICATION';
  }
  if (today > charge.dueDate && paid.minor < charge.expectedAmount.minor) {
    return 'OVERDUE';
  }
  if (paid.minor > 0) {
    return 'PARTIAL';
  }
  return 'PENDING';
}

export function addPayment(
  charge: Charge,
  input: { amount: Money; reference: string; createdAt: string },
  today: string,
): Payment {
  const status = evaluateStatus(charge, today);
  if (status === 'PAID' || status === 'PENDING_VERIFICATION') {
    throw new ConflictError(
      `Charge ${charge.id} is locked in status ${status} and cannot accept new payments`,
    );
  }
  if (input.amount.currency !== charge.expectedAmount.currency) {
    throw new DomainValidationError(
      `Payment currency ${input.amount.currency} does not match charge currency ${charge.expectedAmount.currency}`,
    );
  }
  if (input.amount.isZero()) {
    throw new DomainValidationError('Payment amount must be greater than zero');
  }
  const reference = input.reference?.trim() ?? '';
  if (reference.length === 0) {
    throw new DomainValidationError('Payment reference is required');
  }
  const { paid, remaining } = chargeTotals(charge);
  if (paid.plus(input.amount).minor > charge.expectedAmount.minor) {
    throw new DomainValidationError(
      `Payment exceeds remaining balance of ${remaining.toDecimal().toFixed(2)}`,
    );
  }

  const payment: Payment = {
    id: randomUUID(),
    chargeId: charge.id,
    amount: input.amount,
    reference,
    status: 'PENDING_CONFIRMATION',
    createdAt: input.createdAt,
    confirmedAt: null,
  };
  charge.payments.push(payment);
  return payment;
}

export function confirmPayment(charge: Charge, paymentId: string, at: string): Payment {
  const payment = charge.payments.find((candidate) => candidate.id === paymentId);
  if (!payment) {
    throw new NotFoundError(`Payment ${paymentId} not found on charge ${charge.id}`);
  }
  if (payment.status === 'CONFIRMED') {
    throw new ConflictError(`Payment ${paymentId} is already confirmed`);
  }
  payment.status = 'CONFIRMED';
  payment.confirmedAt = at;
  return payment;
}
