import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from '../src/domain/errors';
import { Money } from '../src/domain/money';
import { calculateDueDate, createContract } from '../src/domain/contract';
import {
  addPayment,
  chargeTotals,
  confirmPayment,
  createCharge,
  evaluateStatus,
  type Charge,
} from '../src/domain/charge';

const COP = 'COP' as const;

function makeCharge(overrides: {
  expected: number;
  period?: string;
  dueDate?: string;
  id?: string;
}): Charge {
  return createCharge({
    id: overrides.id ?? 'charge-1',
    contractId: 'contract-1',
    period: overrides.period ?? '2026-01',
    expectedAmount: Money.fromDecimal(overrides.expected, COP),
    dueDate: overrides.dueDate ?? '2026-01-31',
  });
}

describe('Money', () => {
  it('rejects negative and non-integer minor amounts', () => {
    expect(() => Money.fromMinor(-1, COP)).toThrow(DomainValidationError);
    expect(() => Money.fromMinor(10.5, COP)).toThrow(DomainValidationError);
    expect(() => Money.fromMinor(100, 'EUR' as typeof COP)).toThrow(DomainValidationError);
  });

  it('rejects non-finite decimal values', () => {
    expect(() => Money.fromDecimal(Number.NaN, COP)).toThrow(DomainValidationError);
    expect(() => Money.fromDecimal(Number.POSITIVE_INFINITY, COP)).toThrow(DomainValidationError);
    expect(() => Money.fromDecimal(-5, COP)).toThrow(DomainValidationError);
  });

  it('rounds decimals half-up to minor units', () => {
    expect(Money.fromDecimal(1234.567, COP).minor).toBe(123457);
    expect(Money.fromDecimal(1234.564, COP).minor).toBe(123456);
    expect(Money.fromDecimal(0, COP).isZero()).toBe(true);
  });

  it('refuses to combine mismatched currencies', () => {
    const cop = Money.fromMinor(1000, COP);
    const usd = Money.fromMinor(1000, 'USD');
    expect(() => cop.plus(usd)).toThrow(DomainValidationError);
    expect(cop.equals(Money.fromMinor(1000, COP))).toBe(true);
    expect(cop.equals(usd)).toBe(false);
  });
});

describe('calculateDueDate', () => {
  it('clamps day 31 to the last valid day of short months', () => {
    expect(calculateDueDate(2026, 2, 31)).toBe('2026-02-28');
    expect(calculateDueDate(2028, 2, 31)).toBe('2028-02-29');
    expect(calculateDueDate(2026, 4, 31)).toBe('2026-04-30');
    expect(calculateDueDate(2026, 1, 31)).toBe('2026-01-31');
  });

  it('rejects invalid month and day inputs', () => {
    expect(() => calculateDueDate(2026, 13, 1)).toThrow(DomainValidationError);
    expect(() => calculateDueDate(2026, 0, 1)).toThrow(DomainValidationError);
    expect(() => calculateDueDate(2026, 1, 32)).toThrow(DomainValidationError);
  });
});

describe('createContract', () => {
  it('trims names and rejects empty ones', () => {
    const contract = createContract({
      propertyName: '  Apto 302  ',
      tenantName: 'Ana',
      monthlyRent: Money.fromDecimal(1500000, COP),
      paymentDayOfMonth: 31,
      startDate: '2026-01-01',
    });
    expect(contract.propertyName).toBe('Apto 302');
    expect(contract.status).toBe('ACTIVE');

    expect(() =>
      createContract({
        propertyName: '   ',
        tenantName: 'Ana',
        monthlyRent: Money.fromDecimal(1500000, COP),
        paymentDayOfMonth: 1,
        startDate: '2026-01-01',
      }),
    ).toThrow(DomainValidationError);
  });

  it('rejects out-of-range payment day and malformed start dates', () => {
    const base = {
      propertyName: 'Apto 302',
      tenantName: 'Ana',
      monthlyRent: Money.fromDecimal(1500000, COP),
      startDate: '2026-01-01',
    };
    expect(() => createContract({ ...base, paymentDayOfMonth: 0 })).toThrow(
      DomainValidationError,
    );
    expect(() => createContract({ ...base, paymentDayOfMonth: 32 })).toThrow(
      DomainValidationError,
    );
    expect(() => createContract({ ...base, paymentDayOfMonth: 1, startDate: '01-01-2026' })).toThrow(
      DomainValidationError,
    );
  });
});

describe('Charge lifecycle', () => {
  const beforeDue = '2026-01-15';
  const afterDue = '2026-02-05';

  it('is PENDING with no payments', () => {
    const charge = makeCharge({ expected: 1000000 });
    expect(evaluateStatus(charge, beforeDue)).toBe('PENDING');
    expect(chargeTotals(charge).remaining.toDecimal()).toBe(1000000);
  });

  it('is PARTIAL after a confirmed partial payment before the due date', () => {
    const charge = makeCharge({ expected: 1000000 });
    const payment = addPayment(
      charge,
      { amount: Money.fromDecimal(300000, COP), reference: 'TRX-1', createdAt: '2026-01-10T10:00:00.000Z' },
      beforeDue,
    );
    confirmPayment(charge, payment.id, '2026-01-11T10:00:00.000Z');

    expect(evaluateStatus(charge, beforeDue)).toBe('PARTIAL');
    expect(chargeTotals(charge).confirmed.toDecimal()).toBe(300000);
    expect(chargeTotals(charge).remaining.toDecimal()).toBe(700000);
  });

  it('is PENDING_VERIFICATION when the full amount awaits confirmation', () => {
    const charge = makeCharge({ expected: 1000000 });
    addPayment(
      charge,
      { amount: Money.fromDecimal(1000000, COP), reference: 'TRX-2', createdAt: '2026-01-10T10:00:00.000Z' },
      beforeDue,
    );

    expect(chargeTotals(charge).awaitingConfirmation.toDecimal()).toBe(1000000);
    expect(evaluateStatus(charge, beforeDue)).toBe('PENDING_VERIFICATION');
  });

  it('is PAID once the full amount is confirmed', () => {
    const charge = makeCharge({ expected: 1000000 });
    const payment = addPayment(
      charge,
      { amount: Money.fromDecimal(1000000, COP), reference: 'TRX-3', createdAt: '2026-01-10T10:00:00.000Z' },
      beforeDue,
    );
    confirmPayment(charge, payment.id, '2026-01-11T10:00:00.000Z');

    expect(evaluateStatus(charge, beforeDue)).toBe('PAID');
    expect(evaluateStatus(charge, afterDue)).toBe('PAID');
    expect(chargeTotals(charge).remaining.isZero()).toBe(true);
  });

  it('is OVERDUE with a partial history once today passes the due date', () => {
    const charge = makeCharge({ expected: 1000000 });
    const payment = addPayment(
      charge,
      { amount: Money.fromDecimal(250000, COP), reference: 'TRX-4', createdAt: '2026-01-10T10:00:00.000Z' },
      beforeDue,
    );
    confirmPayment(charge, payment.id, '2026-01-11T10:00:00.000Z');

    expect(evaluateStatus(charge, afterDue)).toBe('OVERDUE');
  });

  it('is OVERDUE with no payments once today passes the due date', () => {
    const charge = makeCharge({ expected: 1000000 });
    expect(evaluateStatus(charge, afterDue)).toBe('OVERDUE');
  });

  it('rejects overpayment with the exact remaining balance in the message', () => {
    const charge = makeCharge({ expected: 1000000 });
    const payment = addPayment(
      charge,
      { amount: Money.fromDecimal(149999.5, COP), reference: 'TRX-5', createdAt: '2026-01-10T10:00:00.000Z' },
      beforeDue,
    );
    confirmPayment(charge, payment.id, '2026-01-11T10:00:00.000Z');

    expect(() =>
      addPayment(
        charge,
        { amount: Money.fromDecimal(900000, COP), reference: 'TRX-6', createdAt: '2026-01-12T10:00:00.000Z' },
        beforeDue,
      ),
    ).toThrow(/850000\.50/);
  });

  it('rejects empty references, zero amounts and currency mismatches', () => {
    const charge = makeCharge({ expected: 1000000 });
    expect(() =>
      addPayment(
        charge,
        { amount: Money.fromDecimal(1000, COP), reference: '   ', createdAt: '2026-01-10T10:00:00.000Z' },
        beforeDue,
      ),
    ).toThrow(DomainValidationError);
    expect(() =>
      addPayment(
        charge,
        { amount: Money.fromMinor(0, COP), reference: 'TRX-7', createdAt: '2026-01-10T10:00:00.000Z' },
        beforeDue,
      ),
    ).toThrow(DomainValidationError);
    expect(() =>
      addPayment(
        charge,
        { amount: Money.fromDecimal(1000, 'USD'), reference: 'TRX-8', createdAt: '2026-01-10T10:00:00.000Z' },
        beforeDue,
      ),
    ).toThrow(DomainValidationError);
  });

  it('locks the charge while it is PENDING_VERIFICATION', () => {
    const charge = makeCharge({ expected: 1000000 });
    addPayment(
      charge,
      { amount: Money.fromDecimal(1000000, COP), reference: 'TRX-9', createdAt: '2026-01-10T10:00:00.000Z' },
      beforeDue,
    );

    expect(() =>
      addPayment(
        charge,
        { amount: Money.fromDecimal(1, COP), reference: 'TRX-10', createdAt: '2026-01-10T10:00:00.000Z' },
        beforeDue,
      ),
    ).toThrow(ConflictError);
  });

  it('rejects a second confirmation and unknown payment ids', () => {
    const charge = makeCharge({ expected: 1000000 });
    const payment = addPayment(
      charge,
      { amount: Money.fromDecimal(1000000, COP), reference: 'TRX-11', createdAt: '2026-01-10T10:00:00.000Z' },
      beforeDue,
    );
    confirmPayment(charge, payment.id, '2026-01-11T10:00:00.000Z');

    expect(() => confirmPayment(charge, payment.id, '2026-01-12T10:00:00.000Z')).toThrow(
      ConflictError,
    );
    expect(() => confirmPayment(charge, 'missing-payment', '2026-01-11T10:00:00.000Z')).toThrow(
      NotFoundError,
    );
  });

  it('validates period, due date and contract id when creating a charge', () => {
    expect(() =>
      createCharge({
        contractId: 'contract-1',
        period: '2026-13',
        expectedAmount: Money.fromDecimal(100, COP),
        dueDate: '2026-01-31',
      }),
    ).toThrow(DomainValidationError);
    expect(() =>
      createCharge({
        contractId: 'contract-1',
        period: '2026-01',
        expectedAmount: Money.fromDecimal(100, COP),
        dueDate: '2026-01-32',
      }),
    ).toThrow(DomainValidationError);
    expect(() =>
      createCharge({
        contractId: '  ',
        period: '2026-01',
        expectedAmount: Money.fromDecimal(100, COP),
        dueDate: '2026-01-31',
      }),
    ).toThrow(DomainValidationError);
  });
});
