import { DatabaseSync } from 'node:sqlite';

// Single source of truth for the physical schema. Kept as one idempotent script
// so every process (API, seed, tests) converges to the same shape on open.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS contracts (
  id            TEXT PRIMARY KEY,
  property_name TEXT NOT NULL,
  tenant_name   TEXT NOT NULL,
  rent_minor    INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  payment_day   INTEGER NOT NULL,
  start_date    TEXT NOT NULL,
  status        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS charges (
  id             TEXT PRIMARY KEY,
  contract_id    TEXT NOT NULL REFERENCES contracts(id),
  period         TEXT NOT NULL,
  expected_minor INTEGER NOT NULL,
  due_date       TEXT NOT NULL,
  UNIQUE(contract_id, period)
);

CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  charge_id    TEXT NOT NULL REFERENCES charges(id),
  amount_minor INTEGER NOT NULL,
  reference    TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_charges_contract_period ON charges(contract_id, period);
CREATE INDEX IF NOT EXISTS idx_payments_charge ON payments(charge_id);
`;

/**
 * Opens (and migrates) the ledger database.
 *
 * Money is never stored as a decimal: rent and payment amounts live as integer
 * minor units plus a currency code, so all arithmetic downstream stays exact.
 */
export function openDatabase(path?: string): DatabaseSync {
  const dbPath = path ?? process.env.DB_PATH ?? 'faro.db';
  const db = new DatabaseSync(dbPath);

  // WAL improves read concurrency for file-backed databases; it is a no-op
  // concept for in-memory databases used by tests.
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  // Enforce the contract -> charge -> payment referential chain.
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(SCHEMA);
  return db;
}
