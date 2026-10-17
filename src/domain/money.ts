import { DomainValidationError } from './errors';

export type Currency = 'COP' | 'USD';

const SUPPORTED_CURRENCIES: readonly Currency[] = ['COP', 'USD'];

/**
 * Immutable money value object. Amounts are stored in minor units (integer
 * cents) so arithmetic never accumulates floating point drift.
 */
export class Money {
  readonly minor: number;
  readonly currency: Currency;

  constructor(minor: number, currency: Currency) {
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      throw new DomainValidationError(`Unsupported currency: ${String(currency)}`);
    }
    if (!Number.isInteger(minor) || minor < 0) {
      throw new DomainValidationError(`Invalid amount in minor units: ${minor}`);
    }
    this.minor = minor;
    this.currency = currency;
  }

  static fromMinor(minor: number, currency: Currency): Money {
    return new Money(minor, currency);
  }

  static fromDecimal(value: number, currency: Currency): Money {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new DomainValidationError(`Invalid decimal amount: ${String(value)}`);
    }
    if (value < 0) {
      throw new DomainValidationError('Amount cannot be negative');
    }
    // Math.round rounds .5 away from zero, which matches half-up for positives.
    return new Money(Math.round(value * 100), currency);
  }

  toDecimal(): number {
    return this.minor / 100;
  }

  plus(other: Money): Money {
    if (other.currency !== this.currency) {
      throw new DomainValidationError(
        `Cannot combine amounts in ${this.currency} and ${other.currency}`,
      );
    }
    return new Money(this.minor + other.minor, this.currency);
  }

  equals(other: Money): boolean {
    return this.minor === other.minor && this.currency === other.currency;
  }

  isZero(): boolean {
    return this.minor === 0;
  }
}
