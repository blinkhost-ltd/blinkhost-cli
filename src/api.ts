import { randomUUID } from 'node:crypto';
import { activeProfile, type Profile, writeConfig } from './config.js';
import { deleteRefreshCredential, getRefreshCredential, setRefreshCredential } from './credentials.js';
import { CliError, EXIT } from './errors.js';
import { VERSION } from './version.js';

const REQUEST_TIMEOUT_MS = 30_000;

interface TokenResponse { access_token: string; refresh_token: string; token_type: string; expires_in: number }

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
    const response = await fetch(new URL(path, `${apiOrigin}/`), {
      ...init,
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': `BlinkHost-CLI/${VERSION}`, ...Object.fromEntries(new Headers(init.headers).entries()) },
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
    const result = await publicRequest(selected.profile.apiOrigin, '/api/cli/v2/token/refresh/', { method: 'POST', body: JSON.stringify({ refresh_token: refresh }) });
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
