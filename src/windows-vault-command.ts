import { CliError, EXIT } from './errors.js';

/** Read-only type loading; cold PowerShell startup may exceed five seconds. */
export function windowsVaultProbe(): { command: string; args: string[]; timeoutMs: number } {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop';try{[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]}catch{exit 3}"],
    timeoutMs: 15_000,
  };
}

/** Fixed PowerShell program; credentials travel only through the input pipe. */
export function windowsVaultCommand(action: 'get' | 'set' | 'delete', profile: string, token?: string): {
  command: string; args: string[]; input?: string;
} {
  if (!profile || profile.length > 128 || !/^[\x20-\x7e]+$/.test(profile)) {
    throw new CliError('The credential profile is invalid.', EXIT.auth, 'invalid_profile');
  }
  if (action === 'set' && (typeof token !== 'string' || !/^bhr_[A-Za-z0-9_-]{32,256}$/.test(token))) {
    throw new CliError('The server returned an invalid refresh credential.', EXIT.auth, 'invalid_refresh_credential');
  }
  const user = profile.replace(/'/g, "''");
  const prefix = `$ErrorActionPreference='Stop';try{$r='blinkhost-cli';$u='${user}';[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$p=New-Object Windows.Security.Credentials.PasswordVault}catch{exit 3};`;
  const missing = 'catch{if($_.Exception.GetBaseException().HResult -eq -2147023728){exit 2}else{exit 3}}';
  let operation: string;
  if (action === 'get') {
    operation = `try{$c=$p.Retrieve($r,$u);$c.RetrievePassword();[Console]::Out.Write($c.Password)}${missing}`;
  } else if (action === 'delete') {
    operation = `try{$c=$p.Retrieve($r,$u);$p.Remove($c)}${missing}`;
  } else if (action === 'set') {
    // Do not delete the prior credential before Add. A failed write must not
    // become an application-created missing-item window. No fallback/retry.
    // Validate again after pipe transport; PowerShell must fail nonzero even
    // for non-terminating errors. Never print exceptions or credential values.
    operation = "try{$s=[Console]::In.ReadToEnd();if($s -cnotmatch '\\Abhr_[A-Za-z0-9_-]{32,256}\\z'){exit 3};$p.Add((New-Object Windows.Security.Credentials.PasswordCredential($r,$u,$s)))}catch{exit 3}";
  } else {
    throw new CliError('Invalid credential-service operation.', EXIT.internal, 'credential_store_configuration_invalid');
  }
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', prefix + operation],
    ...(action === 'set' ? { input: token! } : {}) };
}
