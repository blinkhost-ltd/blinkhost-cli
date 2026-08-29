import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { activeProfile, validateApiOrigin, validateProfileName, writeConfig } from './config.js';
import { deleteRefreshCredential, setRefreshCredential } from './credentials.js';
import { ApiClient, publicRequest } from './api.js';
import { CliError, EXIT } from './errors.js';
import { VERSION } from './version.js';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    const selected = await activeProfile(options.profile);
    const profileName = validateProfileName(options.profile || selected.name);
    const apiOrigin = validateApiOrigin(options.apiOrigin || selected.profile.apiOrigin);
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const started = await publicRequest(apiOrigin, '/api/cli/v2/device/start/', {
        method: 'POST',
        body: JSON.stringify({ code_challenge: challenge, client_name: 'BlinkHost CLI', client_version: VERSION, device_name: hostname().slice(0, 120) }),
    });
    if (!started.response.ok)
        throw new CliError('BlinkHost could not start CLI authorization.', EXIT.auth, errorCode(started.data) || 'authorization_start_failed');
    const device = started.data;
    options.progress?.(`Open ${device.verification_uri_complete}`);
    options.progress?.(`Confirm code ${device.user_code}`);
    if (options.openBrowser !== false)
        openBrowser(device.verification_uri_complete);
    const deadline = Date.now() + device.expires_in * 1000;
    while (Date.now() < deadline) {
        await sleep(Math.max(device.interval, 5) * 1000);
        const polled = await publicRequest(apiOrigin, '/api/cli/v2/device/poll/', { method: 'POST', body: JSON.stringify({ device_code: device.device_code, code_verifier: verifier }) });
        const code = errorCode(polled.data);
        if (code === 'authorization_pending' || code === 'slow_down')
            continue;
        if (!polled.response.ok)
            throw new CliError(code === 'access_denied' ? 'CLI authorization was denied.' : 'CLI authorization could not be completed.', EXIT.auth, code || 'authorization_failed');
        const tokens = polled.data;
        await setRefreshCredential(profileName, tokens.refresh_token);
        selected.config.profiles[profileName] = { apiOrigin };
        selected.config.activeProfile = profileName;
        await writeConfig(selected.config);
        const client = await ApiClient.create(profileName);
        const capabilities = await client.request('/api/cli/v2/capabilities/');
        await client.rememberIdentity(capabilities.actor || {});
        return { profile: profileName, api_origin: apiOrigin, account: capabilities.actor, permissions: capabilities.features };
    }
    throw new CliError('CLI authorization expired before it was approved.', EXIT.auth, 'authorization_expired');
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