import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, EXIT } from './errors.js';
export const DEFAULT_API_ORIGIN = 'https://api.blinkhost.me';
function configRoot() {
    const override = process.env.BLINKHOST_CONFIG_HOME;
    if (override)
        return override;
    if (process.platform === 'win32' && process.env.APPDATA)
        return join(process.env.APPDATA, 'BlinkHost');
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'blinkhost');
}
export function configPath() { return join(configRoot(), 'config.json'); }
export function validateProfileName(value) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value))
        throw new CliError('Profile names use lowercase letters, numbers, hyphens, and underscores.', EXIT.usage, 'invalid_profile');
    return value;
}
export function validateApiOrigin(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new CliError('The API origin is not a valid URL.', EXIT.usage, 'invalid_api_origin');
    }
    const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
        throw new CliError('Use an HTTPS API origin without credentials, paths, queries, or fragments.', EXIT.usage, 'invalid_api_origin');
    }
    return parsed.origin;
}
export async function readConfig() {
    try {
        const parsed = JSON.parse(await readFile(configPath(), 'utf8'));
        const profiles = {};
        for (const [name, profile] of Object.entries(parsed.profiles || {})) {
            validateProfileName(name);
            if (!profile || typeof profile !== 'object')
                continue;
            profiles[name] = { ...profile, apiOrigin: validateApiOrigin(profile.apiOrigin) };
        }
        return { activeProfile: validateProfileName(parsed.activeProfile || 'default'), profiles, plugins: parsed.plugins || {} };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { activeProfile: 'default', profiles: {} };
        if (error instanceof CliError)
            throw error;
        throw new CliError('BlinkHost CLI configuration could not be read.', EXIT.filesystem, 'config_invalid');
    }
}
export async function writeConfig(config) {
    const path = configPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
}
export async function activeProfile(explicit) {
    const config = await readConfig();
    const name = validateProfileName(explicit || process.env.BLINKHOST_PROFILE || config.activeProfile || 'default');
    return { name, profile: config.profiles[name] || { apiOrigin: DEFAULT_API_ORIGIN }, config };
}
//# sourceMappingURL=config.js.map