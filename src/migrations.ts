import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ApiClient } from './api.js';
import { CliError, EXIT } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const SQL_LIMIT = 16 * 1024;
const statuses = ['pending', 'applied', 'failed', 'rolled_back'];

function invalid(message: string): never {
  throw new CliError(message, EXIT.usage, 'invalid_migration_input');
}

function malformed(): never {
  throw new CliError('The API returned an incomplete or inconsistent migration record.', EXIT.remote, 'invalid_migration_response');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
  return value as Record<string, unknown>;
}

function string(value: unknown, pattern?: RegExp): string {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) return malformed();
  return value;
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function resolveWorkspace(client: ApiClient, project: string, explicit?: string): Promise<string> {
  if (explicit !== undefined) return explicit;
  const metadata = record(await client.request(`/api/sites/${project}/`));
  const workspace = metadata.organization;
  if (metadata.id !== project || !(typeof workspace === 'string' && /^[1-9]\d*$/.test(workspace)
      || typeof workspace === 'number' && Number.isSafeInteger(workspace) && workspace > 0)) {
    throw new CliError('Migrations require an accessible project in a workspace.', EXIT.remote, 'project_workspace_unavailable');
  }
  return String(workspace);
}

async function readSql(path: string): Promise<string> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > SQL_LIMIT) return invalid('Use a UTF-8 SQL file of at most 16 KiB.');
      const bytes = Buffer.alloc(SQL_LIMIT + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > SQL_LIMIT) return invalid('SQL exceeds 16 KiB.');
      let sql: string;
      try { sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
      catch { return invalid('Use valid UTF-8 in the SQL file.'); }
      if (!sql.trim() || sql.includes('\0')) return invalid('Supply non-empty SQL without NUL characters.');
      return sql;
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Could not read the SQL file.', EXIT.filesystem, 'migration_sql_unreadable');
  }
}

function readReview(value: unknown, project: string, environment: string, version: number, sql: string) {
  const plan = record(value);
  const source = record(plan.review);
  const tenant = record(source.project);
  const identity = record(source.identity);
  const migrationId = string(plan.migration_id, UUID);
  if (tenant.id !== project || source.environment !== environment || source.version !== version
      || source.migration_id !== migrationId || source.sql !== sql || source.checksum !== hash(sql)) return malformed();
  const sources = Object.entries(record(source.schema_sources)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const schemaSources = Object.fromEntries(sources.map(([key, digest]) => [key, digest === null ? null : string(digest, HASH)]));
  const review = {
    project: { id: project, name: string(tenant.name) }, migration_id: migrationId, environment, version,
    checksum: hash(sql), sql,
    identity: { database_id: string(identity.database_id, /\S/), binding_id: string(identity.binding_id, /\S/), generation: string(identity.generation, /\S/) },
    before_sha256: string(source.before_sha256, HASH), after_sha256: string(source.after_sha256, HASH),
    schema_sources: schemaSources, target_schema_sql: string(source.target_schema_sql),
  };
  // Stop for new review fields until this CLI knows how to display and bind them.
  if (Object.keys(source).some(k => !Object.hasOwn(review, k))
      || Object.keys(tenant).some(k => !Object.hasOwn(review.project, k))
      || Object.keys(identity).some(k => !Object.hasOwn(review.identity, k))) return malformed();
  const status = string(plan.status);
  if (!statuses.includes(status)) return malformed();
  return { review, status, token: string(plan.review_token, /^[\x21-\x7e]{1,256}$/) };
}

function result(value: unknown, id: string, expectedChecksum?: string) {
  const row = record(value);
  const status = string(row.status);
  const phase = string(row.phase);
  // Older migration metadata can predate both a native plan and a SQL checksum.
  const unplannedStatus = expectedChecksum === undefined && phase === 'unplanned' && status !== 'applied';
  const checksum = unplannedStatus && row.checksum === null ? null : string(row.checksum, HASH);
  if (row.migration_id !== id || !statuses.includes(status) || !['unplanned', 'planned', 'dispatched'].includes(phase)
      || (expectedChecksum && (status !== 'applied' || expectedChecksum !== checksum))
      || (status === 'applied' ? phase !== 'dispatched' || row.verification !== 'fresh_primary_history' : row.verification !== undefined)) return malformed();
  return { migration_id: id, status, phase, checksum, ...(status === 'applied' ? { verification: 'fresh_primary_history' } : {}) };
}

export async function runMigrations(args: string[], profile?: string) {
  const [action, projectArg, ...rest] = args;
  if (!['plan', 'apply', 'status'].includes(action || '') || !projectArg || !UUID.test(projectArg)) {
    return invalid('Use migrations plan, apply or status followed by the project UUID. See blinkhost help migrations.');
  }
  const project = projectArg.toLowerCase();
  const id = action === 'plan' ? undefined : rest.shift()?.toLowerCase();
  if (action !== 'plan' && (!id || !UUID.test(id))) return invalid('Supply the migration UUID from plan.');
  const options = {
    environment: { type: 'string' }, organization: { type: 'string' },
    version: { type: 'string' }, file: { type: 'string' }, 'confirm-review': { type: 'string' },
  } as const;
  let values;
  try {
    const parsed = parseArgs({ args: rest, options, strict: true, tokens: true });
    const names = parsed.tokens.map(t => 'name' in t ? t.name : '');
    if (new Set(names).size !== names.length) return invalid('Use each migration option once.');
    values = parsed.values;
  } catch { return invalid('Invalid migration options. See blinkhost help migrations.'); }
  if (action !== 'apply' && values['confirm-review'] !== undefined
      || action === 'status' && (values.version !== undefined || values.file !== undefined)) {
    return invalid('Unexpected option for this migration command.');
  }
  const environment = values.environment;
  if (!environment || !['development', 'preview', 'production'].includes(environment)) {
    return invalid('Specify --environment development, preview or production.');
  }
  const version = Number(values.version);
  if (action !== 'status' && (!/^[1-9]\d{0,4}$/.test(values.version || '') || version > 10000 || !values.file)) {
    return invalid('Specify --version 1 through 10000 and --file PATH.');
  }
  const confirmation = values['confirm-review'];
  if (action === 'apply' && (!confirmation || !HASH.test(confirmation))) {
    return invalid('Read the complete plan and pass its SHA-256 with --confirm-review.');
  }
  if (values.organization !== undefined && !/^[1-9]\d{0,18}$/.test(values.organization)) {
    return invalid('Use a positive numeric workspace ID with --organization.');
  }
  const sql = action === 'status' ? '' : await readSql(values.file!);
  const client = await ApiClient.create(profile);
  const workspace = await resolveWorkspace(client, project, values.organization);
  const path = `/api/migrations/projects/${project}/`;
  const headers = { 'X-Organization-Id': workspace };
  const recovery = `blinkhost migrations status ${project} ${id} --environment ${environment} --organization ${workspace} --profile ${client.profileName}`;
  const status = async (migrationId: string, checksum?: string) => result(await client.request(
    path + migrationId + '/status/?environment=' + environment, { headers }, 16384), migrationId, checksum);
  if (action === 'status') return status(id!);
  const body = JSON.stringify({ environment, version, sql, expected_checksum: hash(sql) });
  const plan = readReview(await client.request(path + 'plan/', { method: 'POST', headers, body }, 2 * 1024 * 1024),
    project, environment, version, sql);
  const scope = { api_origin: client.profile.apiOrigin, organization_id: workspace };
  const digest = hash(JSON.stringify({ format: 'blinkhost/migration-review/v1', ...scope, review: plan.review }));
  if (action === 'plan') {
    return { migration_id: plan.review.migration_id, status: plan.status, ...scope, review: plan.review, review_sha256: digest };
  }
  if (plan.review.migration_id !== id || digest !== confirmation || !['pending', 'applied'].includes(plan.status)) {
    throw new CliError('The selected migration, plan or status differs. Inspect its status and review a new plan.',
      EXIT.conflict, 'migration_review_changed', [recovery]);
  }
  try {
    if (plan.status === 'applied') return await status(id!, plan.review.checksum);
    const applied = await client.request(path + id + '/apply/', { method: 'POST', headers,
      body: JSON.stringify({ environment, review_token: plan.token, confirm: true }) }, 16384);
    return result(applied, id!, plan.review.checksum);
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError('Could not confirm apply.', EXIT.remote, 'migration_apply_unconfirmed');
    throw new CliError('The CLI could not confirm a verified apply. Check status before taking another action.',
      failure.exitCode, failure.code, [...failure.details, recovery]);
  }
}
