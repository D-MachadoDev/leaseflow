import { randomUUID } from 'crypto';
import { DomainValidationError } from './errors';
import { Money } from './money';

export type ContractStatus = 'ACTIVE' | 'ENDED';

export interface Contract {
  id: string;
  propertyName: string;
  tenantName: string;
  monthlyRent: Money;
  paymentDayOfMonth: number; // 1..31
  startDate: string; // 'YYYY-MM-DD'
  status: ContractStatus;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return lengths[month - 1];
}

function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  return day <= daysInMonth(year, month);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Resolves the billing due date for a period. Contracts agreed on day 29/30/31
 * must clamp to the last valid day of short months (e.g. February) so no charge
 * is skipped or pushed into the next period (RN-02).
 */
export function calculateDueDate(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new DomainValidationError(`Invalid year: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new DomainValidationError(`Invalid month: ${month}`);
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new DomainValidationError(`Invalid day: ${day}`);
  }
  const clampedDay = Math.min(day, daysInMonth(year, month));
  return `${year}-${pad2(month)}-${pad2(clampedDay)}`;
}

export function createContract(input: {
  id?: string;
  propertyName: string;
  tenantName: string;
  monthlyRent: Money;
  paymentDayOfMonth: number;
  startDate: string;
}): Contract {
  const propertyName = input.propertyName?.trim() ?? '';
  const tenantName = input.tenantName?.trim() ?? '';
  if (propertyName.length === 0) {
    throw new DomainValidationError('propertyName is required');
  }
  if (tenantName.length === 0) {
    throw new DomainValidationError('tenantName is required');
  }
  if (
    !Number.isInteger(input.paymentDayOfMonth) ||
    input.paymentDayOfMonth < 1 ||
    input.paymentDayOfMonth > 31
  ) {
    throw new DomainValidationError(
      `paymentDayOfMonth must be between 1 and 31, received ${input.paymentDayOfMonth}`,
    );
  }
  if (!isValidIsoDate(input.startDate)) {
    throw new DomainValidationError(`startDate must be a valid YYYY-MM-DD date: ${input.startDate}`);
  }

  const id = input.id?.trim();
  if (input.id !== undefined && (!id || id.length === 0)) {
    throw new DomainValidationError('id must be a non-empty string when provided');
  }

  return {
    id: id && id.length > 0 ? id : randomUUID(),
    propertyName,
    tenantName,
    monthlyRent: input.monthlyRent,
    paymentDayOfMonth: input.paymentDayOfMonth,
    startDate: input.startDate,
    status: 'ACTIVE',
  };
}
