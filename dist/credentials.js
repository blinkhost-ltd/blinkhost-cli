import { spawn } from 'node:child_process';
import { CliError, EXIT } from './errors.js';
const SERVICE = 'blinkhost-cli';
async function executableAvailable(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true });
        child.once('error', () => resolve(false));
        child.once('exit', (code) => resolve(code === 0));
    });
}
/** Checks only whether the platform credential service can be invoked. */
export async function credentialStoreStatus() {
    if (process.platform === 'darwin') {
        const available = await executableAvailable('security', ['help']);
        return { available, provider: 'macos-keychain', remediation: available ? null : 'Restore the macOS security command before interactive sign-in.' };
    }
    if (process.platform === 'win32') {
        const available = await executableAvailable('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]']);
        return { available, provider: 'windows-password-vault', remediation: available ? null : 'Use Windows with PowerShell and Password Vault available.' };
    }
    const available = await executableAvailable('secret-tool', ['--version']);
    return { available, provider: 'linux-secret-service', remediation: available ? null : 'Install libsecret tools and start an unlocked Secret Service session, or use a short-lived workload identity in headless automation.' };
}
async function run(command, args, input, acceptMissing = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
        child.on('error', () => reject(new CliError('No supported operating-system credential service is available.', EXIT.auth, 'credential_store_unavailable')));
        child.on('close', (code) => {
            if (code === 0)
                resolve(stdout.trim());
            else if (acceptMissing)
                resolve('');
            else
                reject(new CliError(`The operating-system credential service rejected the request${stderr.trim() ? `: ${stderr.trim()}` : '.'}`, EXIT.auth, 'credential_store_failed'));
        });
        if (input !== undefined)
            child.stdin.end(input);
        else
            child.stdin.end();
    });
}
function windowsScript(action, profile) {
    const safeProfile = profile.replace(/'/g, "''");
    const prefix = `$r='${SERVICE}';$u='${safeProfile}';$v=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];`;
    if (action === 'get')
        return `${prefix}try{$c=(New-Object Windows.Security.Credentials.PasswordVault).Retrieve($r,$u);$c.RetrievePassword();[Console]::Out.Write($c.Password)}catch{exit 2}`;
    if (action === 'delete')
        return `${prefix}try{$p=New-Object Windows.Security.Credentials.PasswordVault;$c=$p.Retrieve($r,$u);$p.Remove($c)}catch{};`;
    return `${prefix}$s=[Console]::In.ReadToEnd();$p=New-Object Windows.Security.Credentials.PasswordVault;try{$c=$p.Retrieve($r,$u);$p.Remove($c)}catch{};$p.Add((New-Object Windows.Security.Credentials.PasswordCredential($r,$u,$s)));`;
}
export async function getRefreshCredential(profile) {
    if (process.platform === 'darwin')
        return (await run('security', ['find-generic-password', '-s', SERVICE, '-a', profile, '-w'], undefined, true)) || null;
    if (process.platform === 'win32')
        return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsScript('get', profile)], undefined, true)) || null;
    return (await run('secret-tool', ['lookup', 'service', SERVICE, 'profile', profile], undefined, true)) || null;
}
export async function setRefreshCredential(profile, token) {
    if (!token.startsWith('bhr_'))
        throw new CliError('The server returned an invalid refresh credential.', EXIT.auth, 'invalid_refresh_credential');
    if (process.platform === 'darwin') {
        await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', profile, '-w', token]);
        return;
    }
    if (process.platform === 'win32') {
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsScript('set', profile)], token);
        return;
    }
    await run('secret-tool', ['store', '--label=BlinkHost CLI', 'service', SERVICE, 'profile', profile], token);
}
export async function deleteRefreshCredential(profile) {
    if (process.platform === 'darwin') {
        await run('security', ['delete-generic-password', '-s', SERVICE, '-a', profile], undefined, true);
        return;
    }
    if (process.platform === 'win32') {
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsScript('delete', profile)], undefined, true);
        return;
    }
    await run('secret-tool', ['clear', 'service', SERVICE, 'profile', profile], undefined, true);
}
//# sourceMappingURL=credentials.js.map