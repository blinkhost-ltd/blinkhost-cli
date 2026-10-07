import { readFile, readdir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ApiClient } from './api.js';
import { CliError, EXIT } from './errors.js';

export const SEO_VERSION = 'blinkhost-seo/v1';
export const SEO_RULESET = '2026-10-05.1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requestIdentity(value: string | undefined, repeated: boolean): string {
  if (!value || !uuid.test(value) || repeated) throw new CliError('Provide --request-id UUID exactly once.', EXIT.usage, 'seo_request_id_invalid');
  return value;
}
async function boundedFile(file: string, maximum = 100000): Promise<Buffer> {
  const handle = await open(resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new CliError(`Use an ordinary file up to ${maximum} bytes.`, EXIT.validation, 'seo_document_limit');
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximum) throw new CliError('File exceeds the size limit.', EXIT.validation, 'seo_document_limit');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
async function boundedJson(file: string, maximum = 100000): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedFile(file, maximum)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Provide a valid UTF-8 JSON object.', EXIT.validation, 'seo_json_invalid');
  }
}
function validPublicPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || value.startsWith('//') || /[?#%\\\x00-\x20\x7f]/.test(value)) return false;
  return !value.split('/').some(part => part === '.' || part === '..');
}
function validateSubmission(body: Record<string, unknown>, kind: 'search' | 'sample' | 'research'): void {
  if (kind === 'research') {
    const fields = ['client_request_id', 'model', 'maximum_units', 'query', 'max_reads', 'public_query_consent'];
    const invalid = Object.keys(body).length !== fields.length || Object.keys(body).some(key => !fields.includes(key))
      || typeof body.client_request_id !== 'string' || !uuid.test(body.client_request_id)
      || typeof body.model !== 'string' || !body.model || body.model.length > 40
      || !Number.isInteger(body.maximum_units) || Number(body.maximum_units) < 1 || Number(body.maximum_units) > 2000
      || typeof body.query !== 'string' || !body.query || body.query !== body.query.trim()
      || Buffer.byteLength(body.query) > 512 || /\p{C}/u.test(body.query)
      || !Number.isInteger(body.max_reads) || Number(body.max_reads) < 1 || Number(body.max_reads) > 5
      || body.public_query_consent !== true;
    if (invalid) throw new CliError('Use an explicit public query, consent and spending limits. Keep client_request_id unchanged when retrying.', EXIT.validation, 'seo_submission_invalid');
    return;
  }
  const fields = kind === 'search' ? ['client_request_id', 'query', 'count', 'locale'] : ['client_request_id', 'model', 'maximum_units', 'question', 'paths', 'required_facts'];
  const text = body[kind === 'search' ? 'query' : 'question'];
  let invalid = Object.keys(body).some(key => !fields.includes(key)) || typeof body.client_request_id !== 'string' || !uuid.test(body.client_request_id)
    || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 1000 || /[\x00-\x1f\x7f]/.test(text);
  if (kind === 'search') {
    invalid ||= body.count !== undefined && (!Number.isInteger(body.count) || Number(body.count) < 1 || Number(body.count) > 10);
    invalid ||= body.locale !== undefined && body.locale !== null && (typeof body.locale !== 'string' || body.locale.length > 63 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(body.locale));
  } else {
    invalid ||= typeof body.model !== 'string' || !body.model || body.model.length > 40
      || !Number.isInteger(body.maximum_units) || Number(body.maximum_units) < 1 || Number(body.maximum_units) > 2000
      || !Array.isArray(body.paths) || body.paths.length < 1 || body.paths.length > 5 || body.paths.some(path => !validPublicPath(path)) || new Set(body.paths).size !== body.paths.length
      || !Array.isArray(body.required_facts) || body.required_facts.length > 20 || body.required_facts.some(fact => typeof fact !== 'string' || !fact.trim() || Buffer.byteLength(fact) > 300 || /[\x00-\x1f\x7f]/.test(fact));
  }
  if (invalid) throw new CliError(`Invalid ${kind} request. Keep client_request_id unchanged when retrying.`, EXIT.validation, 'seo_submission_invalid');
}
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map(match => [(match[1] ?? '').toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '']));
}
function privateDocument(html: string): boolean {
  return [...html.matchAll(/<meta\b[^>]*>/gi)].some(match => {
    const attrs = attributes(match[0]);
    return (attrs.name?.toLowerCase() === 'robots' && /\bnoindex\b/i.test(attrs.content ?? '')) ||
      (attrs.name?.toLowerCase() === 'blinkhost:visibility' && attrs.content?.toLowerCase() === 'private');
  });
}
export interface LocalFinding { key: string; rule: string; rule_version: string; path: string; severity: string; confidence: string; evidence: Record<string, unknown>; remedy: string; source: string; state: string; content_is_untrusted: boolean }

export function checkLocalHtml(html: string, path: string, source: string): LocalFinding[] {
  const findings: LocalFinding[] = [];
  const add = (rule: string, severity: string, evidence: Record<string, unknown>, remedy: string) => {
    const key = createHash('sha256').update(JSON.stringify([rule, path])).digest('hex');
    findings.push({ key, rule, rule_version: SEO_RULESET, path, severity, confidence: 'high', evidence, remedy, source, state: 'open', content_is_untrusted: true });
  };
  // Local parser intentionally bounds coverage. Hosted audits use an HTML parser
  // and network/render evidence. Private/noindex intent isn't guessed locally.
  const titles = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)];
  if (titles.length !== 1 || !titles[0]?.[1]?.trim()) add('metadata.title', 'warning', { titles: titles.length }, 'Give this page one descriptive title.');
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => match[0]);
  if (!metas.some(tag => /\bname\s*=\s*["']description["']/i.test(tag) && /\bcontent\s*=\s*["'][^"']+/i.test(tag))) add('metadata.description', 'warning', { present: false }, 'Add a concise description of this page.');
  const canonicals = [...html.matchAll(/<link\b[^>]*>/gi)].filter(match => /\brel\s*=\s*["']canonical["']/i.test(match[0]));
  if (canonicals.length !== 1) add('metadata.canonical', 'error', { canonicals: canonicals.length }, 'Use one absolute canonical URL for the intended public page.');
  else {
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(canonicals[0]?.[0] ?? '')?.[1] ?? '';
    try { const url = new URL(href); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.hash) throw new Error(); }
    catch { add('metadata.canonical', 'error', { canonical: href }, 'Use one absolute canonical URL for the intended public page.'); }
  }
  return findings;
}

export async function localAudit(directory: string, gate = false): Promise<Record<string, unknown>> {
  const root = resolve(directory);
  const files: string[] = [];
  let visited = 0;
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 10000) throw new CliError('Local scan exceeds 10,000 entries.', EXIT.validation, 'seo_scan_limit');
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name.startsWith('_') || ['node_modules', 'vendor'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.html') && !['404.html', '500.html'].includes(entry.name)) files.push(path);
    }
  }
  if ((await lstat(root)).isSymbolicLink()) throw new CliError('Scan an ordinary directory.', EXIT.validation, 'seo_symlink');
  await visit(root);
  const findings: LocalFinding[] = [];
  let checked = 0;
  for (const file of files) {
    if ((await lstat(file)).size > 1048576) throw new CliError('HTML exceeds the local 1 MiB limit.', EXIT.validation, 'seo_document_limit');
    const source = relative(root, file).replaceAll('\\', '/');
    const path = '/' + (source.endsWith('index.html') ? source.slice(0, -10) : source.slice(0, -5));
    const html = await readFile(file, 'utf8');
    if (privateDocument(html)) continue;
    checked++;
    findings.push(...checkLocalHtml(html, path, source));
  }
  const blocking = findings.filter(item => item.severity === 'error').map(item => item.key);
  return { version: SEO_VERSION, ruleset: SEO_RULESET, findings,
    coverage: { mode: 'local-html', files: checked, excluded: files.length - checked, rules: ['metadata.title', 'metadata.description', 'metadata.canonical'], unsupported: ['network status', 'rendering', 'dynamic route enumeration', 'intent validation'] },
    gate: { enabled: gate, passed: !gate || (checked > 0 && !blocking.length), incomplete: checked === 0, blocking: gate ? blocking : [] } };
}

export async function runSeo(args: string[], profile?: string): Promise<Record<string, unknown>> {
  const action = args.shift();
  if (action === 'local') {
    const gate = args.includes('--gate');
    const remaining = args.filter(arg => arg !== '--gate');
    if (remaining.length > 1) throw new CliError('Use seo local DIRECTORY [--gate].', EXIT.usage, 'seo_usage');
    return localAudit(remaining[0] ?? '.', gate);
  }
  const projectId = args.shift();
  if (!projectId || !uuid.test(projectId)) throw new CliError('Provide the project UUID.', EXIT.usage, 'seo_project_required');
  const base = `/api/seo/projects/${projectId}/audits/`;
  let client: ApiClient | undefined;
  const request = async (path: string, options?: Parameters<ApiClient['request']>[1]) => {
    client ??= await ApiClient.create(profile);
    return client.request(path, options);
  };
  const projectBase = `/api/seo/projects/${projectId}/`;
  const post = async (path: string, body: unknown) => await request(path, { method: 'POST', body: JSON.stringify(body) }) as Record<string, unknown>;
  const submitTask = async (path: string, body: Record<string, unknown>) => {
    try { return await post(path, body); }
    catch (error) {
      if (error instanceof CliError) throw new CliError(error.message, error.exitCode, error.code, [
        ...error.details, `SEO request ID: ${body.client_request_id}`,
        `If submission is uncertain, retry the unchanged command with --request-id ${body.client_request_id}.`,
      ]);
      throw error;
    }
  };
  if (['content-status', 'content-index', 'content-delete', 'samples', 'research-status'].includes(action ?? '') && !args.length) {
    const path = `${projectBase}${action === 'samples' ? 'samples' : action === 'research-status' ? 'research' : 'content/index'}/`;
    if (action === 'content-index') return post(path, {});
    return await request(path, action === 'content-delete' ? { method: 'DELETE' } : undefined) as Record<string, unknown>;
  }
  if (['content-search', 'sample', 'research'].includes(action ?? '') && args.length === 1) {
    const body = await boundedJson(args[0]!);
    validateSubmission(body, action === 'sample' ? 'sample' : action === 'research' ? 'research' : 'search');
    return post(`${projectBase}${action === 'sample' ? 'samples' : action === 'research' ? 'research' : 'content/search'}/`, body);
  }
  if (['content-result', 'sample-result', 'sample-delete', 'research-result', 'research-cancel'].includes(action ?? '') && args.length === 1 && uuid.test(args[0]!)) {
    const path = `${projectBase}${action === 'content-result' ? 'content/search' : action?.startsWith('research-') ? 'research' : 'samples'}/${args[0]}/`;
    return await request(path, action === 'sample-delete' || action === 'research-cancel' ? { method: 'DELETE' } : undefined) as Record<string, unknown>;
  }
  if ((action === 'diagnostics' || action === 'field') && !args.length) return await request(`${projectBase}${action}/`) as Record<string, unknown>;
  if (action === 'import-native' && args.length === 3) {
    const [format, exportFile, metadataFile] = args;
    if (!['google-search-console-csv', 'google-search-console-zip', 'bing-webmaster-csv'].includes(format!)) throw new CliError('Choose a supported native export format.', EXIT.usage, 'seo_import_format');
    const provenance = await boundedJson(metadataFile!, 10000);
    const data = await boundedFile(exportFile!, 1_450_000);
    let content: string;
    try { content = format!.endsWith('-zip') ? data.toString('base64') : new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new CliError('CSV must be UTF-8.', EXIT.validation, 'seo_import_encoding'); }
    const body = { version: SEO_VERSION, native_format: format, provenance, content };
    if (Buffer.byteLength(JSON.stringify(body)) > 2_000_000) throw new CliError('Report exceeds 2 MB.', EXIT.validation, 'seo_document_limit');
    return post(`${projectBase}imports/`, body);
  }
  if ((action === 'import' || action === 'docs-evaluate') && args.length === 1) {
    const body = await boundedJson(args[0]!, 2_000_000);
    return post(`${projectBase}${action === 'import' ? 'imports' : 'docs/evaluate'}/`, body);
  }
  if (action === 'audit' || action === 'verify') {
    const auditId = action === 'verify' ? args.shift() : undefined;
    if (action === 'verify' && (!auditId || !uuid.test(auditId))) throw new CliError('Provide the audit UUID.', EXIT.usage, 'seo_audit_required');
    const options: Record<string, unknown> = {client_request_id: randomUUID(), page_limit: 100};
    let explicitRequestId = false;
    while (args.length) {
      const flag = args.shift();
      if (flag === '--gate') options.gate = true;
      else if (flag === '--request-id') {
        options.client_request_id = requestIdentity(args.shift(), explicitRequestId);
        explicitRequestId = true;
      }
      else if (flag === '--changed') options.scope = 'changed';
      else if (flag === '--paths') {
        const value = args.shift()?.split(',');
        if (!value?.length || value.some(path => !path.startsWith('/') || path.startsWith('//') || /[?#\\\x00-\x20]/.test(path))) throw new CliError('Provide comma-separated public route paths.', EXIT.usage, 'seo_paths');
        options.paths = value;
      }
      else if (flag === '--baseline') {
        const value = args.shift();
        if (!value || !uuid.test(value)) throw new CliError('Provide the baseline audit UUID.', EXIT.usage, 'seo_baseline');
        options.baseline_id = value;
      }
      else if (flag === '--pages' || flag === '--browser-pages') {
        const value = Number(args.shift());
        if (!Number.isInteger(value) || value < (flag === '--pages' ? 1 : 0) || value > (flag === '--pages' ? 1000 : 10)) throw new CliError('Invalid scan bounds.', EXIT.usage, 'seo_bounds');
        options[flag === '--pages' ? 'page_limit' : 'browser_limit'] = value;
      } else throw new CliError('Unknown SEO option.', EXIT.usage, 'seo_usage');
    }
    if (Array.isArray(options.paths) && options.paths.length > Number(options.page_limit)) throw new CliError('Paths exceed the page limit.', EXIT.usage, 'seo_paths');
    return submitTask(action === 'audit' ? base : `${base}${auditId}/verify/`, options);
  }
  if (action === 'findings' && args.length === 1 && uuid.test(args[0] ?? "")) return await request(`${base}${args[0]}/`) as Record<string, unknown>;
  if (action === 'cancel' && args.length === 1 && uuid.test(args[0] ?? "")) return post(`${base}${args[0]}/cancel/`, {});
  if (action === 'remediate') {
    const auditId = args.shift();
    const body: Record<string, unknown> = {client_request_id: randomUUID()};
    let explicitRequestId = false;
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (flag === '--model') body.model = value;
      else if (flag === '--request-id') {
        body.client_request_id = requestIdentity(value, explicitRequestId);
        explicitRequestId = true;
      }
      else if (flag === '--max-units') body.maximum_units = Number(value);
      else if (flag === '--findings') body.finding_keys = value?.split(',');
      else throw new CliError('Unknown remediation option.', EXIT.usage, 'seo_usage');
    }
    if ((!auditId || !uuid.test(auditId)) || typeof body.model !== 'string' || !body.model || !Number.isInteger(body.maximum_units) || Number(body.maximum_units) < 1 || Number(body.maximum_units) > 2000 || !Array.isArray(body.finding_keys) || !body.finding_keys.length || body.finding_keys.length > 10 || body.finding_keys.some(key => !/^[0-9a-f]{64}$/.test(String(key)))) throw new CliError('Use seo remediate PROJECT AUDIT --model MODEL --max-units N --findings KEY,KEY.', EXIT.usage, 'seo_model_budget_required');
    return submitTask(`${base}${auditId}/remediate/`, body);
  }
  throw new CliError('See blinkhost help seo for audit, documentation search and model experiment commands.', EXIT.usage, 'seo_usage');
}
