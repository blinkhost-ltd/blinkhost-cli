/** Explicit permissions and protected schema for a fresh owned local database. */
import { randomUUID } from 'node:crypto';

export function nativeDatabasePermissions(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || ['read', 'write', 'transaction'].some(key => !Object.hasOwn(value, key) || typeof value[key] !== 'boolean')
    || !(value.read || value.write || value.transaction)) throw new Error('invalid_local_native_database_permissions');
  return { read: value.read, write: value.write, transaction: value.transaction };
}

// Kept identical to edge::runtime::database::schema; the source conformance test
// checks all three definitions. No IF NOT EXISTS: unexpected preexisting state
// fails startup rather than adopting another scope or weakening receipt rules.
export const RECEIPT_SCHEMA = `CREATE TABLE __blinkhost_receipts (
    scope TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    result TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(created_at>=0),
    PRIMARY KEY(scope, operation_id)
) WITHOUT ROWID`;
export const RECEIPT_INDEX_SCHEMA = `CREATE INDEX __blinkhost_receipt_results
    ON __blinkhost_receipts(created_at) WHERE result IS NOT NULL`;
export const STATE_SCHEMA = `CREATE TABLE __blinkhost_database_state (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
    database_id TEXT NOT NULL, generation TEXT NOT NULL,
    environment TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1)
) WITHOUT ROWID`;

export function newNativeDatabase(permissions) {
  const checked = nativeDatabasePermissions(permissions);
  if (!checked) return null;
  const database_id = randomUUID(), generation = randomUUID();
  return { grant: { database_id, generation, permissions: checked },
    scope: { database_id, generation, environment: 'development', namespace: 'customer-local' },
    setup: [{ sql: RECEIPT_SCHEMA }, { sql: RECEIPT_INDEX_SCHEMA }, { sql: STATE_SCHEMA },
      { sql: 'INSERT INTO __blinkhost_database_state VALUES(1, ?1, ?2, ?3, 1)', args: [
        { type: 'text', value: database_id }, { type: 'text', value: generation }, { type: 'text', value: 'development' } ] }] };
}
