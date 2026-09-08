import { publicRequest } from './api.js';
import { CliError, EXIT } from './errors.js';
const services = {
    request: publicRequest,
    now: () => performance.now(),
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};
function expired() {
    throw new CliError('This sign-in code has expired. Run `blinkhost auth login` again to get a new code.', EXIT.auth, 'authorization_expired');
}
function validatePolling(device) {
    if (!device || typeof device.device_code !== 'string' || !device.device_code || device.device_code.length > 4096
        || !Number.isSafeInteger(device.expires_in) || device.expires_in < 1 || device.expires_in > 3600
        || !Number.isSafeInteger(device.interval) || device.interval < 1 || device.interval > 60) {
        throw new CliError('BlinkHost returned an invalid sign-in request. No authorization checks were sent.', EXIT.auth, 'authorization_response_invalid');
    }
}
/** Validate the server contract before displaying terminal text or launching a browser. */
export function validateDeviceAuthorization(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new CliError('BlinkHost returned an invalid sign-in request.', EXIT.auth, 'authorization_response_invalid');
    }
    const device = data;
    validatePolling(device);
    // The service's published verification endpoint is fixed, including for custom API profiles.
    // Exact matching also excludes shell metacharacters on Windows and terminal control text.
    if (typeof device.user_code !== 'string' || device.user_code.length !== 9 || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(device.user_code)
        || device.verification_uri_complete !== `https://app.blinkhost.me/cli/authorize?code=${device.user_code}`) {
        throw new CliError('BlinkHost returned an invalid sign-in address or code. No browser was opened.', EXIT.auth, 'authorization_response_invalid');
    }
    return device;
}
export function validateDeviceTokens(data) {
    const tokens = data;
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)
        || typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 16384
        || typeof tokens.refresh_token !== 'string' || tokens.refresh_token.trim() !== tokens.refresh_token
        || !/^bhr_[A-Za-z0-9_-]{32,256}$/.test(tokens.refresh_token)) {
        throw new CliError('BlinkHost returned an invalid sign-in session. No new credential was saved.', EXIT.auth, 'authorization_response_invalid');
    }
    return { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
}
/** Pending authorization is safe to poll; token delivery and network failures are not retried. */
export async function pollDeviceAuthorization(apiOrigin, device, verifier, dependencies = services) {
    validatePolling(device);
    const deadline = dependencies.now() + device.expires_in * 1000;
    let interval = Math.max(device.interval, 5) * 1000;
    while (dependencies.now() < deadline) {
        await dependencies.sleep(Math.min(interval, Math.max(0, deadline - dependencies.now())));
        if (dependencies.now() >= deadline)
            return expired();
        const polled = await dependencies.request(apiOrigin, '/api/cli/v2/device/poll/', {
            method: 'POST', body: JSON.stringify({ device_code: device.device_code, code_verifier: verifier }),
        });
        const data = polled.data;
        const code = data && typeof data === 'object' && typeof data.error === 'string'
            ? data.error : '';
        if (!polled.response.ok) {
            if (code === 'authorization_pending')
                continue;
            // OAuth device-flow slow_down increases this and every subsequent interval.
            if (code === 'slow_down') {
                interval += 5000;
                continue;
            }
            if (code === 'expired_token')
                return expired();
            if (code === 'access_denied')
                throw new CliError('CLI authorization was denied. No new session was saved.', EXIT.auth, 'access_denied');
            throw new CliError('CLI authorization could not be completed. Run `blinkhost auth login` to start a new sign-in.', EXIT.auth, 'authorization_failed');
        }
        return data;
    }
    return expired();
}
//# sourceMappingURL=device-flow.js.map