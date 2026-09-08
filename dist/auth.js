import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { activeProfile, validateApiOrigin, validateProfileName, writeConfig } from './config.js';
import { credentialStoreStatus, deleteRefreshCredential, setRefreshCredential } from './credentials.js';
import { ApiClient, publicRequest } from './api.js';
import { CliError, EXIT } from './errors.js';
import { VERSION } from './version.js';
import { pollDeviceAuthorization, validateDeviceAuthorization, validateDeviceTokens } from './device-flow.js';
function openBrowser(url) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url] : [url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
    child.on('error', () => { });
    child.unref();
}
function errorCode(data) {
    return data && typeof data === 'object' && typeof data.error === 'string' ? data.error : '';
}
export async function login(options) {
    if (options.scopes && (options.scopes.length > 30 || options.scopes.some(scope => !/^[a-z]+:(?:read|write|execute|approve)$/.test(scope)))) {
        throw new CliError('Use repeated --scope values such as ai:read or ai:execute.', EXIT.usage, 'invalid_scope');
    }
    const credentialStore = await credentialStoreStatus();
    if (!credentialStore.available) {
        throw new CliError(`Secure credential storage is unavailable. ${credentialStore.remediation || 'Set up your operating-system credential service before signing in.'}`, EXIT.auth, 'credential_store_unavailable');
    }
    const selected = await activeProfile(options.profile);
    const profileName = validateProfileName(options.profile || selected.name);
    const apiOrigin = validateApiOrigin(options.apiOrigin || selected.profile.apiOrigin);
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const started = await publicRequest(apiOrigin, '/api/cli/v2/device/start/', {
        method: 'POST',
        body: JSON.stringify({ code_challenge: challenge, client_name: 'BlinkHost CLI', client_version: VERSION, device_name: hostname().slice(0, 120),
            ...(options.scopes ? { scopes: [...new Set(['account:read', ...options.scopes])] } : {}) }),
    });
    if (!started.response.ok)
        throw new CliError('BlinkHost could not start CLI authorization.', EXIT.auth, errorCode(started.data) || 'authorization_start_failed');
    const device = validateDeviceAuthorization(started.data);
    options.progress?.(`Open ${device.verification_uri_complete}`);
    options.progress?.(`Confirm code ${device.user_code}`);
    if (options.openBrowser !== false)
        openBrowser(device.verification_uri_complete);
    const tokens = validateDeviceTokens(await pollDeviceAuthorization(apiOrigin, device, verifier));
    await setRefreshCredential(profileName, tokens.refresh_token);
    selected.config.profiles[profileName] = { apiOrigin };
    selected.config.activeProfile = profileName;
    await writeConfig(selected.config);
    const client = await ApiClient.create(profileName);
    const capabilities = await client.request('/api/cli/v2/capabilities/');
    await client.rememberIdentity(capabilities.actor || {});
    return { profile: profileName, api_origin: apiOrigin, account: capabilities.actor, permissions: capabilities.features };
}
export async function logout(profile) {
    const selected = await activeProfile(profile);
    try {
        const client = await ApiClient.create(selected.name);
        await client.request('/api/cli/v2/sessions/current/', { method: 'DELETE' });
    }
    catch (error) {
        if (!(error instanceof CliError) || error.code !== 'session_expired')
            throw error;
    }
    await deleteRefreshCredential(selected.name);
    return { profile: selected.name };
}
//# sourceMappingURL=auth.js.map