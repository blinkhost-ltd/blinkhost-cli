export interface CredentialStoreStatus {
    available: boolean;
    provider: 'macos-keychain' | 'windows-password-vault' | 'linux-secret-service';
    remediation: string | null;
}
/** Checks only whether the platform credential service can be invoked. */
export declare function credentialStoreStatus(): Promise<CredentialStoreStatus>;
export declare function getRefreshCredential(profile: string): Promise<string | null>;
export declare function setRefreshCredential(profile: string, token: string): Promise<void>;
export declare function deleteRefreshCredential(profile: string): Promise<void>;
