import { randomUUID } from 'node:crypto';
import { activeProfile, type Profile, writeConfig } from './config.js';
import { deleteRefreshCredential, getRefreshCredential, setRefreshCredential } from './credentials.js';
import { CliError, EXIT } from './errors.js';
import { VERSION } from './version.js';

const REQUEST_TIMEOUT_MS = 30_000;

interface TokenResponse { access_token: string; refresh_token: string; token_type: string; expires_in: number }

// Only locally written guidance may reach terminal output. Never echo server
// details, filenames or arbitrary codes from a source-export error response.
const EXPORT_GUIDANCE: Readonly<Record<string, { status: number; message: string }>> = {
  project_template_unsupported: { status: 400, message: 'Source export needs a supported frontend configuration. Backend-only projects are not supported by this export path yet. Check the project configuration in BlinkHost; this command has not changed your source.' },
  committed_secret_detected: { status: 409, message: 'Source export was blocked by credential screening. Review possible credentials in your project before sharing it, and rotate any exposed values. Do not paste credentials into a support request.' },
  html_package_invalid: { status: 409, message: 'Source export could not read the HTML project package configuration. Check that package.json is valid JSON and its scripts field is an object.' },
  dependency_lockfile_missing: { status: 409, message: 'Source export needs package-lock.json for this HTML project. Review the project dependencies, then use its normal dependency-install workflow to create the lockfile. This command has not installed or run anything.' },
};

async function exportErrorGuidance(response: Response): Promise<{ code: string; message: string } | undefined> {
  const limit = 8192;
  if (![400, 409].includes(response.status)
      || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
      || !response.body) return;
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) return;
  const reader = response.body.getReader();
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) return;
      chunks.push(Buffer.from(chunk.value));
    }
    if (length !== null && Number(length) !== size) return;
    const payload: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const code = (payload as Record<string, unknown>).code;
    if (typeof code !== 'string' || !Object.hasOwn(EXPORT_GUIDANCE, code)) return;
    const guidance = EXPORT_GUIDANCE[code]!;
    if (guidance.status === response.status) return { code, message: guidance.message };
  } catch {
    // Malformed, incomplete and failed error bodies retain the generic HTTP error.
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function messageFrom(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const candidate = payload as Record<string, unknown>;
    for (const key of ['detail', 'error', 'message']) if (typeof candidate[key] === 'string') return candidate[key];
    const first = Object.values(candidate)[0];
    if (Array.isArray(first) && typeof first[0] === 'string') return first[0];
  }
  return fallback;
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) return response.json();
  const text = await response.text();
  return text.length <= 1024 * 1024 ? text : `${text.slice(0, 1024 * 1024)}\n[truncated]`;
}

export async function publicRequest(apiOrigin: string, path: string, init: RequestInit = {}): Promise<{ response: Response; data: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // Headers are case-insensitive. Object-spreading normalized caller headers
    // into mixed-case defaults makes fetch combine Content-Type values.
    const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': `BlinkHost-CLI/${VERSION}` });
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const response = await fetch(new URL(path, `${apiOrigin}/`), {
      ...init,
      redirect: 'error',
      signal: controller.signal,
      headers,
    });
    return { response, data: await parseResponse(response) };
  } catch (error) {
    if (error instanceof CliError) throw error;
    const timeoutMessage = error instanceof DOMException && error.name === 'AbortError';
    throw new CliError(timeoutMessage ? 'The BlinkHost API request timed out.' : 'The BlinkHost API could not be reached.', EXIT.network, timeoutMessage ? 'request_timeout' : 'network_error');
  } finally { clearTimeout(timeout); }
}

export class ApiClient {
  private accessToken: string;
  private constructor(
    readonly profileName: string,
    readonly profile: Profile,
    accessToken: string,
    private readonly ephemeral: boolean,
  ) { this.accessToken = accessToken; }

  static async create(profileName?: string): Promise<ApiClient> {
    const selected = await activeProfile(profileName);
    const workload = process.env.BLINKHOST_ACCESS_TOKEN;
    if (workload) return new ApiClient(selected.name, selected.profile, workload, true);
    if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
      const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      let oidcUrl: URL;
      try { oidcUrl = new URL(requestUrl); } catch { throw new CliError('GitHub Actions supplied an invalid OIDC endpoint.', EXIT.auth, 'ci_oidc_invalid'); }
      if (oidcUrl.protocol !== 'https:' || !(oidcUrl.hostname === 'actions.githubusercontent.com' || oidcUrl.hostname.endsWith('.actions.githubusercontent.com'))) throw new CliError('GitHub Actions supplied an untrusted OIDC endpoint.', EXIT.auth, 'ci_oidc_invalid');
      oidcUrl.searchParams.set('audience', 'https://api.blinkhost.me/api/cli/v2/workload/exchange/');
      const oidcResponse = await fetch(oidcUrl, { headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/json' }, redirect: 'error' });
      const oidc = await oidcResponse.json() as { value?: string };
      if (!oidcResponse.ok || !oidc.value) throw new CliError('GitHub Actions could not issue a workload identity token.', EXIT.auth, 'ci_oidc_failed');
      const exchanged = await publicRequest(selected.profile.apiOrigin, '/api/cli/v2/workload/exchange/', { method: 'POST', body: JSON.stringify({ assertion: oidc.value }) });
      const payload = exchanged.data as { access_token?: string; detail?: string };
      if (!exchanged.response.ok || !payload.access_token) throw new CliError(payload.detail || 'BlinkHost rejected this workload identity.', EXIT.auth, 'ci_exchange_failed');
      return new ApiClient(selected.name, selected.profile, payload.access_token, true);
    }
    const refresh = process.env.BLINKHOST_REFRESH_TOKEN || await getRefreshCredential(selected.name);
    if (!refresh) throw new CliError('Sign in with `blinkhost auth login` or provide BLINKHOST_ACCESS_TOKEN for CI.', EXIT.auth, 'not_authenticated');
    const result = await publicRequest(selected.profile.apiOrigin, '/api/cli/v2/token/refresh/', { method: 'POST', body: JSON.stringify({ refresh_token: refresh, client_version: VERSION }) });
    if (!result.response.ok) {
      if (!process.env.BLINKHOST_REFRESH_TOKEN) await deleteRefreshCredential(selected.name);
      throw new CliError(messageFrom(result.data, 'Your CLI session has expired. Sign in again.'), EXIT.auth, 'session_expired');
    }
    const tokens = result.data as TokenResponse;
    if (!process.env.BLINKHOST_REFRESH_TOKEN) await setRefreshCredential(selected.name, tokens.refresh_token);
    return new ApiClient(selected.name, selected.profile, tokens.access_token, Boolean(process.env.BLINKHOST_REFRESH_TOKEN));
  }

  static fromAccessToken(profileName: string, profile: Profile, accessToken: string): ApiClient {
    return new ApiClient(profileName, profile, accessToken, true);
  }

  async projectArchive(projectId: string): Promise<Buffer> {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(projectId)) {
      throw new CliError('A valid project UUID is required.', EXIT.usage, 'invalid_project_id');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const requestId = randomUUID();
    const limit = 32 * 1024 * 1024;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(new URL(`/api/source-control/connections/project-export/?project=${projectId}`, this.profile.apiOrigin), {
        method: 'GET', redirect: 'error', signal: controller.signal,
        // Allow the API's JSON error renderer during content negotiation.
        // Successful responses must still pass ZIP-only validation below.
        headers: { Accept: 'application/zip, application/json', Authorization: `Bearer ${this.accessToken}`,
          'X-Request-ID': requestId, 'User-Agent': `BlinkHost-CLI/${VERSION}` },
      });
      if (!response.ok) {
        const guidance = await exportErrorGuidance(response);
        throw new CliError(guidance?.message || `Project export returned HTTP ${response.status}. Check your access and the project's export status in BlinkHost.`,
          [401, 403].includes(response.status) ? EXIT.auth : response.status === 409 ? EXIT.conflict : EXIT.remote,
          `api_${response.status}`, [`Request ID: ${requestId}`, ...(guidance ? [`Export reason: ${guidance.code}`] : [])]);
      }
      const length = response.headers.get('content-length');
      if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/zip'
          || (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) || !response.body) {
        throw new CliError('The export did not return a supported ZIP archive (maximum 32 MiB).', EXIT.validation, 'invalid_project_archive');
      }
      reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new CliError('The project ZIP exceeds the CLI download limit of 32 MiB.', EXIT.validation, 'archive_too_large');
        chunks.push(Buffer.from(chunk.value));
      }
      const body = Buffer.concat(chunks, size);
      // The canonical exporter writes a single-disk ZIP without an archive
      // comment. Check its closing directory record too, not just the prefix.
      const end = size - 22;
      if ((length !== null && Number(length) !== size) || size < 22 || !['504b0304', '504b0506'].includes(body.subarray(0, 4).toString('hex'))
          || body.subarray(end, end + 4).toString('hex') !== '504b0506'
          || body.readUInt16LE(end + 4) !== 0 || body.readUInt16LE(end + 6) !== 0
          || body.readUInt16LE(end + 8) !== body.readUInt16LE(end + 10)
          || body.readUInt16LE(end + 20) !== 0
          || body.readUInt32LE(end + 12) + body.readUInt32LE(end + 16) !== end) {
        throw new CliError('The export response is not a ZIP archive.', EXIT.validation, 'invalid_project_archive');
      }
      return body;
    } catch (error) {
      if (error instanceof CliError) throw error;
      const timedOut = controller.signal.aborted;
      throw new CliError(timedOut ? 'The project export timed out. No archive was saved.' : 'The project export could not be downloaded. No archive was saved.',
        EXIT.network, timedOut ? 'request_timeout' : 'network_error');
    } finally {
      controller.abort();
      if (reader) await reader.cancel().catch(() => undefined);
      clearTimeout(timeout);
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.accessToken}`);
    const requestId = headers.get('X-Request-ID') || randomUUID();
    headers.set('X-Request-ID', requestId);
    if (init.method && init.method !== 'GET' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', randomUUID());
    const result = await publicRequest(this.profile.apiOrigin, path, { ...init, headers });
    if (!result.response.ok) {
      const exit = result.response.status === 401 || result.response.status === 403 ? EXIT.auth : result.response.status === 409 ? EXIT.conflict : EXIT.remote;
      const responseId = result.response.headers.get('x-request-id') || requestId;
      throw new CliError(messageFrom(result.data, `BlinkHost returned HTTP ${result.response.status}.`), exit, `api_${result.response.status}`, [`Request ID: ${responseId}`]);
    }
    return result.data;
  }

  async rememberIdentity(identity: { id?: number; username?: string }): Promise<void> {
    if (this.ephemeral) return;
    const selected = await activeProfile(this.profileName);
    selected.config.profiles[this.profileName] = { ...this.profile, ...(identity.id ? { userId: identity.id } : {}), ...(identity.username ? { username: identity.username } : {}) };
    selected.config.activeProfile = this.profileName;
    await writeConfig(selected.config);
  }
}

export function encodeQuery(values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, value);
  const text = query.toString();
  return text ? `?${text}` : '';
}
