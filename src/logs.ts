import { setTimeout as wait } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { ApiClient } from './api.js';
import { CliError, EXIT } from './errors.js';
import { readProjectLink } from './remote.js';
import { terminalJson, terminalText } from './terminal.js';

const PAGE_BYTES = 2 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
type Filters = Record<string, string>;
export type LogEvent = Record<string, unknown> & { event_id: string; event_time: string };
export type LogEntry = { kind: 'event'; event: LogEvent }
  | { kind: 'notice'; code: string; message: string }
  | { kind: 'summary'; events: number; duplicates_skipped: number; reason: string; filters: Filters; has_more: boolean; next_cursor: string | null };
export interface LogClient { request(path: string, init?: RequestInit, responseLimit?: number): Promise<unknown> }
export interface LogOptions { project?: string; filters: Filters; follow: boolean; maxEvents: number; cursor?: string }

function usage(message: string): never { throw new CliError(message, EXIT.usage, 'invalid_log_options'); }
function integer(value: string, min: number, max: number, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) usage(`${name} must be an integer from ${min} to ${max}.`);
  return Number(value);
}
function instant(value: string, now: number): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) usage('Use a timezone-aware ISO timestamp with at most millisecond precision.');
  // Date.parse normalizes some invalid calendar dates. Check the local date too.
  const local = Date.parse(`${match[1]}T${match[2]}${match[3] || ''}Z`);
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`) usage('Invalid calendar timestamp.');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now) usage('The timestamp must be valid and no later than the current time.');
  return new Date(parsed).toISOString();
}
export function sinceFilters(value: string, now = Date.now(), aggregate = false): Filters {
  const duration = /^(\d+)(s|m|h|d)$/.exec(value);
  if (duration) {
    const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    const milliseconds = Number(duration[1]) * units[duration[2]!]!;
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 366 * 86_400_000) usage('--since must be a positive duration up to 366d.');
    return aggregate ? { hours: String(Math.ceil(milliseconds / 3_600_000)) }
      : { start_time: new Date(now - milliseconds).toISOString() };
  }
  if (aggregate) usage('Metrics and analytics --since use a duration (s, m, h or d), rounded up to whole hours.');
  return { start_time: instant(value, now) };
}

function validatePredicates(raw: string): void {
  if (Buffer.byteLength(raw) > 8192) usage('Custom filter JSON is limited to 8192 UTF-8 bytes.');
  let input: unknown;
  const numberSources = new WeakMap<object, Map<string, string>>();
  try {
    input = JSON.parse(raw, function (this: object, key: string, value: unknown, context?: { source?: string }) {
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || !context?.source) usage('Custom numbers must be finite and use a supported Node.js version.');
        const sources = numberSources.get(this) || new Map<string, string>();
        sources.set(key, context.source); numberSources.set(this, sources);
      }
      return value;
    });
  } catch { usage('Custom filters must be valid finite JSON.'); }
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) usage('Choose one to eight custom filters.');
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Array.isArray(item.path) || item.path.length < 1 || item.path.length > 4
      || typeof item.path[0] !== 'string' || !item.path.every((key: unknown, index: number) => typeof key === 'string' ? /^[a-z][a-z0-9_.]{0,79}$/.test(key) : /^\d+$/.test(numberSources.get(item.path)?.get(String(index)) || '') && Number.isInteger(key) && Number(key) >= 0 && Number(key) < 64)) usage('Every custom filter needs a valid nested field path.');
    const keys = Object.keys(item).sort().join(',');
    if (['exists', 'not_exists'].includes(item.op)) {
      if (keys !== 'op,path') usage('Existence filters accept only path and op.');
      continue;
    }
    if (keys !== 'op,path,type,value') usage('Comparison filters require path, op, type and value.');
    const numeric = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(item.op);
    const numberSource = numberSources.get(item)?.get('value') || '';
    const integerToken = /^-?\d+$/.test(numberSource);
    const valid = item.type === 'string' ? typeof item.value === 'string' && Buffer.byteLength(item.value) <= 1024 && ['eq', 'ne', 'contains', 'prefix'].includes(item.op)
      : item.type === 'integer' ? integerToken && BigInt(numberSource) >= -(BigInt(1) << BigInt(63)) && BigInt(numberSource) < (BigInt(1) << BigInt(64)) && numeric
        : item.type === 'number' ? typeof item.value === 'number' && Number.isFinite(item.value) && (!integerToken || Number.isSafeInteger(item.value)) && numeric
          : item.type === 'boolean' ? typeof item.value === 'boolean' && ['eq', 'ne'].includes(item.op)
            : item.type === 'null' && item.value === null && item.op === 'eq';
    if (!valid) usage('Invalid custom field type, operator or value.');
  }
  // Retain the original JSON, including exact 64-bit integer literals. The API
  // parses and validates their signed/unsigned range without JS rounding.
}

export function parseLogOptions(input: string[], now = Date.now()): LogOptions {
  const filters: Filters = { hours: '1', limit: '100' };
  const options: Record<string, string> = {};
  let follow = false;
  const names = new Set(['project', 'since', 'hours', 'limit', 'max-events', 'cursor', 'attribute-filters',
    'severity', 'event-kind', 'environment-id', 'environment-kind', 'preview-session-id', 'deployment-id',
    'release-id', 'region', 'request-id', 'trace-id', 'source', 'operation', 'outcome', 'status-code', 'search', 'start-time', 'end-time']);
  for (let index = 0; index < input.length; index++) {
    const argument = input[index]!;
    if (argument === '--follow') { if (follow) usage('Do not repeat --follow.'); follow = true; continue; }
    const name = argument.slice(2);
    if (!argument.startsWith('--') || !names.has(name) || Object.hasOwn(options, name)) usage(`Unknown or repeated log option: ${argument}`);
    const value = input[++index];
    if (!value || value.startsWith('--')) usage(`${argument} requires a value.`);
    if (Buffer.byteLength(value) > (name === 'attribute-filters' ? 8192 : name === 'cursor' ? 4096 : 1024)) usage(`${argument} is too large.`);
    options[name] = value;
  }
  if (options.project && !UUID.test(options.project)) usage('--project must be a UUID.');
  if (options.since && (options['start-time'] || options.hours)) usage('Choose --since or --start-time/--hours.');
  if (options.hours) filters.hours = String(integer(options.hours, 1, 8784, '--hours'));
  if (options.limit) filters.limit = String(integer(options.limit, 1, 200, '--limit'));
  if (options.since) Object.assign(filters, sinceFilters(options.since, now));
  for (const name of names) {
    if (['project', 'since', 'hours', 'limit', 'max-events', 'cursor'].includes(name) || !options[name]) continue;
    filters[name.replaceAll('-', '_')] = options[name]!;
  }
  for (const key of ['start_time', 'end_time']) if (filters[key]) filters[key] = instant(filters[key], now);
  if (filters.start_time && filters.end_time && filters.start_time >= filters.end_time) usage('--start-time must be earlier than --end-time.');
  if (filters.attribute_filters) validatePredicates(filters.attribute_filters);
  if (filters.severity && !['debug', 'info', 'warning', 'error', 'critical'].includes(filters.severity)) usage('Invalid severity.');
  if (filters.outcome && !['success', 'failure', 'denied', 'degraded'].includes(filters.outcome)) usage('Invalid outcome.');
  if (filters.event_kind && !['request', 'application_log', 'runtime_metric', 'policy_decision', 'database_operation', 'outbound_call'].includes(filters.event_kind)) usage('Invalid event kind.');
  if (filters.status_code) integer(filters.status_code, 0, 599, '--status-code');
  for (const key of ['environment_id', 'deployment_id']) if (filters[key]) {
    if (!/^\d+$/.test(filters[key]) || BigInt(filters[key]) >= (BigInt(1) << BigInt(64))) usage(`${key} must be an unsigned 64-bit integer.`);
    filters[key] = BigInt(filters[key]).toString();
  }
  if (filters.trace_id) {
    if (!/^[a-f0-9]{32}$/i.test(filters.trace_id)) usage('--trace-id must have 32 hexadecimal characters.');
    filters.trace_id = filters.trace_id.toLowerCase();
  }
  for (const key of ['release_id', 'region', 'request_id', 'source', 'operation', 'search']) if (filters[key] && Array.from(filters[key]).length > 160) usage(`${key} is limited to 160 characters.`);
  if (filters.environment_kind && !['deployed', 'preview'].includes(filters.environment_kind)) usage('--environment-kind must be deployed or preview.');
  if (filters.preview_session_id) {
    if (!UUID.test(filters.preview_session_id)) usage('--preview-session-id must be a UUID.');
    if (filters.environment_kind === 'deployed') usage('Preview sessions require the preview environment kind.');
    filters.environment_kind = 'preview';
  }
  if (filters.environment_kind === 'preview' && (filters.environment_id || filters.deployment_id)) usage('Preview queries cannot include deployed environment or deployment IDs.');
  if (follow && options.cursor) usage('--cursor is for historical reads; start follow from the newest matching records.');
  const maxEvents = options['max-events'] ? integer(options['max-events'], 1, 10_000, '--max-events') : follow ? 10_000 : 200;
  return { filters, follow, maxEvents, ...(options.project ? { project: options.project } : {}), ...(options.cursor ? { cursor: options.cursor } : {}) };
}

type Page = { events: LogEvent[]; has_more: boolean; next_cursor: string | null };
function page(value: unknown): Page {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('Invalid log page.', EXIT.remote, 'invalid_log_response');
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.events) || data.events.length > 200 || typeof data.has_more !== 'boolean'
    || (data.next_cursor !== null && data.next_cursor !== undefined && (typeof data.next_cursor !== 'string' || data.next_cursor.length > 4096))
    || (data.has_more && (!data.events.length || !data.next_cursor))
    || data.events.some(event => !event || typeof event !== 'object' || Array.isArray(event) || typeof event.event_id !== 'string' || event.event_id.length > 128
      || !event.event_id || typeof event.event_time !== 'string' || event.event_time.length > 64)) throw new CliError('Invalid log page or cursor.', EXIT.remote, 'invalid_log_response');
  return { events: data.events, has_more: data.has_more, next_cursor: typeof data.next_cursor === 'string' ? data.next_cursor : null };
}
function filterJson(filters: Filters): string {
  const { attribute_filters, ...rest } = filters;
  const serialized = JSON.stringify(rest);
  return attribute_filters ? serialized.slice(0, -1) + ',"attribute_filters":' + attribute_filters + '}' : serialized;
}
export function serializeLogEvent(event: LogEvent): string {
  const { attributes_json, attributes, ...rest } = event;
  if (typeof attributes_json === 'string' && Buffer.byteLength(attributes_json) <= 131_072) {
    try {
      const parsed: unknown = JSON.parse(attributes_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const pending: [unknown, number][] = [[parsed, 0]];
        let values = 0;
        while (pending.length) {
          const [value, depth] = pending.pop()!;
          if (++values > 4096 || depth > 16 || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Unbounded attribute JSON');
          if (value && typeof value === 'object') for (const child of Object.values(value)) pending.push([child, depth + 1]);
        }
        // Preserve number tokens and string whitespace, while emitting one NDJSON line.
        const compact = attributes_json.replace(/("(?:\\.|[^"\\])*")|[\t\n\r ]+/g, (_match, quoted: string | undefined) => quoted || '');
        return JSON.stringify(rest).slice(0, -1) + ',"attributes":' + compact + '}';
      }
    } catch { /* Retain the delivered values and explicitly qualify precision. */ }
  }
  return JSON.stringify({ ...rest, attributes, precision_notice: 'Exact stored attribute JSON is unavailable; numeric values reflect the API client representation.' });
}
export function renderLogEntry(entry: LogEntry, json: boolean): string {
  if (json) return terminalJson(entry.kind === 'event' ? '{"kind":"event","event":' + serializeLogEvent(entry.event) + '}' : JSON.stringify(entry)) + '\n';
  if (entry.kind === 'event') return terminalText(`${JSON.stringify(entry.event.event_time)} ${JSON.stringify(entry.event.severity ?? '')} ${JSON.stringify(entry.event.message ?? '')}`) + '\n';
  if (entry.kind === 'notice') return terminalText(`Notice [${entry.code}]: ${entry.message}`) + '\n';
  return terminalText(`${entry.events} events; ${entry.reason}; ${entry.duplicates_skipped} duplicate IDs skipped${entry.has_more ? '; more retained records are available' : ''}.`
    + (entry.next_cursor ? `\nContinue with --cursor ${JSON.stringify(entry.next_cursor)} and the same filters${entry.filters.start_time ? `, including --start-time ${JSON.stringify(entry.filters.start_time)}` : ''}.` : '')) + '\n';
}

/** Stop waiting on a stalled terminal pipe when the user interrupts. */
export async function writeLogOutput(output: Pick<NodeJS.WriteStream, 'write'>, value: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return await new Promise<boolean>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); resolve(false); };
    signal.addEventListener('abort', aborted, { once: true });
    try { output.write(value, error => {
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(true);
    }); } catch (error) {
      signal.removeEventListener('abort', aborted);
      reject(error);
    }
  });
}

/** Stream one bounded page at a time; every write is awaited by the caller. */
export async function readLogs(client: LogClient, options: LogOptions & { project: string }, emit: (entry: LogEntry, signal: AbortSignal) => Promise<void>, interruptSignal: AbortSignal,
  pause: (ms: number, signal: AbortSignal) => Promise<void> = async (ms, abort) => { await wait(ms, undefined, { signal: abort }); }): Promise<void> {
  let signal = options.follow ? interruptSignal : AbortSignal.any([interruptSignal, AbortSignal.timeout(120_000)]);
  const stopReason = () => interruptSignal.aborted ? 'interrupted' : options.follow ? 'live-tail ticket expired' : 'time limit reached';
  const base = `/api/sites/${options.project}/observability/`;
  let ticket = '', expires = Infinity, count = 0, duplicates = 0, watermark = '', nextCursor: string | null = options.cursor || null, more = false, reason = 'history exhausted';
  const seen = new Set<string>();
  const historicalCursors = new Set<string>();
  let totalPages = 0;
  const remember = (id: string) => { seen.add(id); if (seen.size > 1000) seen.delete(seen.values().next().value!); };
  const notice = (code: string, message: string) => emit({ kind: 'notice', code, message }, signal);
  const requestPage = async (path: string): Promise<unknown> => {
    const queryId = randomUUID();
    try {
      return await client.request(path, { signal, headers: { 'X-Observability-Query-Id': queryId, ...(ticket ? { 'X-Live-Tail-Ticket': ticket } : {}) } }, PAGE_BYTES);
    } catch (error) {
      if (signal.aborted || (error instanceof CliError && error.exitCode === EXIT.network)) {
        try {
          const closed = await client.request(`/api/observability-query-leases/${queryId}/cancel/`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) }, PAGE_BYTES);
          if (!closed || typeof closed !== 'object' || (closed as Record<string, unknown>).cancelled !== true) throw new Error('Unconfirmed');
        } catch (cancelError) {
          // 409 means the owned lease was already released/cancelled. A 404
          // can race admission, so do not falsely claim provider cancellation.
          if (!(cancelError instanceof CliError && cancelError.code === 'api_409')) await notice('query_cancel_unconfirmed', 'Provider-query cancellation could not be confirmed; its server deadline still applies.');
        }
      }
      throw error;
    }
  };
  try {
    if (options.follow) {
      const result = await client.request(base + 'live-tail-tickets/', { method: 'POST', body: '{"filters":' + filterJson(options.filters) + '}', signal }, PAGE_BYTES);
      if (!result || typeof result !== 'object') throw new CliError('Invalid live-tail ticket response.', EXIT.remote, 'invalid_log_response');
      const data = result as Record<string, unknown>;
      if (typeof data.ticket === 'string' && data.ticket.length <= 256) ticket = data.ticket;
      expires = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
      if (!ticket || !Number.isFinite(expires) || expires <= Date.now()) throw new CliError('Invalid or expired live-tail ticket.', EXIT.remote, 'invalid_log_response');
      signal = AbortSignal.any([interruptSignal, AbortSignal.timeout(Math.max(1, Math.min(expires - Date.now(), 2_147_483_647)))]);
      await notice('best_effort_follow', 'Follow deduplicates up to 1000 recent IDs and reads at most ten pages per poll. Late arrivals, interruptions and full windows can leave gaps; use retained history.');
    }
    let failures = 0;
    while (!signal.aborted && count < options.maxEvents) {
      if (Date.now() >= expires) { reason = 'live-tail ticket expired'; break; }
      if (!options.follow && totalPages >= 1000) { reason = 'page limit reached'; break; }
      let cursor = options.follow ? null : nextCursor;
      const cursors = options.follow ? new Set<string>() : historicalCursors;
      let newest = '', reachedPrevious = !watermark;
      try {
        for (let pages = 0; pages < 10 && !signal.aborted && count < options.maxEvents && (options.follow || totalPages < 1000); pages++) {
          const requested = Math.min(Number(options.filters.limit), options.maxEvents - count);
          const query = new URLSearchParams(options.follow ? {} : options.filters);
          query.set('limit', String(requested));
          if (cursor) query.set('cursor', cursor);
          const batch = page(await requestPage(base + (options.follow ? 'live-tail/' : 'logs/') + '?' + query));
          totalPages++;
          if (batch.events.length > requested) throw new CliError('Log page exceeded its requested row bound.', EXIT.remote, 'invalid_log_response');
          more = batch.has_more; nextCursor = batch.next_cursor;
          if (!newest) newest = batch.events[0]?.event_id || '';
          for (const event of batch.events) {
            if (signal.aborted) { if (!options.follow) nextCursor = cursor; break; }
            if (options.follow && event.event_id === watermark) { reachedPrevious = true; break; }
            if (!seen.has(event.event_id)) { await emit({ kind: 'event', event }, signal); remember(event.event_id); count++; }
            else duplicates++;
            if (count >= options.maxEvents) break;
          }
          if (options.follow && watermark && reachedPrevious) break;
          if (!more || count >= options.maxEvents) break;
          if (!nextCursor || cursors.has(nextCursor) || nextCursor === cursor) throw new CliError('Log pagination did not advance.', EXIT.remote, 'invalid_log_response');
          cursors.add(nextCursor); cursor = nextCursor;
          if (pages === 9 && options.follow) await notice('continuity_unconfirmed', 'The ten-page polling window was full. Some retained records may be absent from this follow view.');
        }
        if (!options.follow) { if (!more || count >= options.maxEvents) break; continue; }
        if (count >= options.maxEvents) break;
        if (watermark && !reachedPrevious) await notice('continuity_unconfirmed', 'The previous event was absent from the bounded polling window; continuity cannot be confirmed.');
        if (newest) watermark = newest;
        failures = 0;
        await pause(Math.min(2500, Math.max(1, expires - Date.now())), signal);
      } catch (error) {
        if (signal.aborted) break;
        const retryable = options.follow && error instanceof CliError && (error.exitCode === EXIT.network || ['api_429', 'api_502', 'api_503', 'api_504'].includes(error.code));
        if (!retryable || ++failures > 3) throw error;
        await notice('follow_interrupted', 'Log delivery was interrupted. Retrying the scoped ticket; continuity cannot be guaranteed.');
        await pause(Math.min(2500 * 2 ** failures, Math.max(1, expires - Date.now())), signal);
      }
    }
    if (signal.aborted) reason = stopReason();
    else if (count >= options.maxEvents) reason = 'event limit reached';
    await emit({ kind: 'summary', events: count, duplicates_skipped: duplicates, reason, filters: options.filters, has_more: more, next_cursor: options.follow ? null : nextCursor }, signal);
  } catch (error) {
    if (!signal.aborted) throw error;
    await emit({ kind: 'summary', events: count, duplicates_skipped: duplicates, reason: stopReason(), filters: options.filters, has_more: more, next_cursor: options.follow ? null : nextCursor }, signal);
  } finally {
    if (ticket) {
      try { await client.request(base + 'live-tail/', { method: 'DELETE', headers: { 'X-Live-Tail-Ticket': ticket }, signal: AbortSignal.timeout(5000) }, PAGE_BYTES); }
      catch { await notice('ticket_close_unconfirmed', 'Live-tail closure could not be confirmed; its server expiry still applies.'); }
    }
  }
}

export async function runLogCommand(input: string[], profile: string | undefined, emit: (entry: LogEntry, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
  const options = parseLogOptions(input);
  let project = options.project;
  if (!project) { try { project = (await readProjectLink()).project_id; } catch { /* Explicit project guidance below. */ } }
  if (!project || !UUID.test(project)) throw new CliError('Provide --project UUID or link this directory with `blinkhost projects link`.', EXIT.usage, 'project_required');
  if (signal.aborted) return;
  await readLogs(await ApiClient.create(profile), { ...options, project }, emit, signal);
}
