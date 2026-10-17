import type { Request, Response } from 'express';
import { Router } from 'express';
import { DomainValidationError } from '../domain/errors';
import type { BillingService } from '../services/billing-service';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

const CHARGE_STATUSES = [
  'PENDING',
  'PARTIAL',
  'PENDING_VERIFICATION',
  'PAID',
  'OVERDUE',
] as const;

type ChargeStatus = (typeof CHARGE_STATUSES)[number];

// ---------- input validation (throws -> 400 through the error middleware) ----------

// express.json() leaves req.body undefined when nothing was parsed.
function readBody(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new DomainValidationError(`${field} must be a number greater than zero`);
  }
  return value;
}

function requirePaymentDay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) {
    throw new DomainValidationError('paymentDayOfMonth must be an integer between 1 and 31');
  }
  return value;
}

// Calendar validity stays in the domain; the route only enforces the shape.
function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_DATE_SHAPE.test(value)) {
    throw new DomainValidationError(`${field} must be a YYYY-MM-DD date`);
  }
  return value;
}

function requirePeriod(value: unknown): string {
  if (typeof value !== 'string' || !PERIOD_PATTERN.test(value)) {
    throw new DomainValidationError(`period must match YYYY-MM, received ${String(value)}`);
  }
  return value;
}

function requireChargeStatus(value: string): ChargeStatus {
  const status = CHARGE_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new DomainValidationError(`status must be one of: ${CHARGE_STATUSES.join(', ')}`);
  }
  return status;
}

function requireId(value: string, field: string): string {
  const id = value.trim();
  if (id.length === 0) {
    throw new DomainValidationError(`${field} must be a non-empty identifier`);
  }
  return id;
}

function optionalCurrency(value: unknown): 'COP' | 'USD' | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'COP' || value === 'USD') {
    return value;
  }
  throw new DomainValidationError('currency must be COP or USD');
}

/** Absent or empty query filters mean "no filter"; arrays/objects are invalid. */
function optionalFilter(value: unknown, field: string): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new DomainValidationError(`${field} filter must be a single string value`);
  }
  return value;
}

export function createRoutes(service: BillingService): Router {
  const router = Router();

  router.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  router.get('/api/summary', (_req: Request, res: Response) => {
    res.json(service.getSummary());
  });

  router.get('/api/contracts', (_req: Request, res: Response) => {
    res.json({ contracts: service.listContracts() });
  });

  router.post('/api/contracts', (req: Request, res: Response) => {
    const body = readBody(req);
    const contract = service.createContract({
      propertyName: requireString(body.propertyName, 'propertyName'),
      tenantName: requireString(body.tenantName, 'tenantName'),
      monthlyRent: requirePositiveNumber(body.monthlyRent, 'monthlyRent'),
      paymentDayOfMonth: requirePaymentDay(body.paymentDayOfMonth),
      startDate: requireIsoDate(body.startDate, 'startDate'),
      currency: optionalCurrency(body.currency),
    });
    res.status(201).json(contract);
  });

  router.get('/api/charges', (req: Request, res: Response) => {
    const status = optionalFilter(req.query.status, 'status');
    const period = optionalFilter(req.query.period, 'period');
    res.json({
      charges: service.listCharges({
        status: status === undefined ? undefined : requireChargeStatus(status),
        period: period === undefined ? undefined : requirePeriod(period),
      }),
    });
  });

  router.post('/api/charges/generate', (req: Request, res: Response) => {
    const period = requirePeriod(readBody(req).period);
    const { created, skipped } = service.generateCharges(period);
    res.status(created > 0 ? 201 : 200).json({ created, skipped, period });
  });

  router.post('/api/charges/:id/payments', (req: Request, res: Response) => {
    const body = readBody(req);
    const result = service.registerPayment(requireId(req.params.id, 'chargeId'), {
      amount: requirePositiveNumber(body.amount, 'amount'),
      reference: requireString(body.reference, 'reference'),
    });
    res.status(201).json(result);
  });

  router.post('/api/charges/:id/payments/:paymentId/confirm', (req: Request, res: Response) => {
    const result = service.confirmPayment(
      requireId(req.params.id, 'chargeId'),
      requireId(req.params.paymentId, 'paymentId'),
    );
    res.json(result);
  });

  return router;
}
