/** Read-only type loading; cold PowerShell startup may exceed five seconds. */
export declare function windowsVaultProbe(): {
    command: string;
    args: string[];
    timeoutMs: number;
};
/** Fixed PowerShell program; credentials travel only through the input pipe. */
export declare function windowsVaultCommand(action: 'get' | 'set' | 'delete', profile: string, token?: string): {
    command: string;
    args: string[];
    input?: string;
};
