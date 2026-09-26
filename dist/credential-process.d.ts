type Options = {
    input?: string;
    timeoutMs?: number;
    missing?: {
        code: number;
        requireEmptyStderr: boolean;
    };
};
export type CredentialProbe = {
    available: true;
} | {
    available: false;
    failureCode: 'credential_store_timeout' | 'credential_store_unavailable' | 'credential_store_response_invalid' | 'credential_store_failed';
};
/** Read-only availability checks retain a safe category, never native output. */
export declare function credentialProbe(command: string, args: string[], timeoutMs?: number): Promise<CredentialProbe>;
/** OS credential helpers only; never retry a possibly completed credential write. */
export declare function credentialCommand(command: string, args: string[], options?: Options): Promise<string>;
export {};
