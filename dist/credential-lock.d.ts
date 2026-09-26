export declare function credentialLockPath(profile: string): string;
/** Serialize the complete read/rotate/save operation across CLI processes. */
export declare function withCredentialLock<T>(profile: string, operation: () => Promise<T>, timeoutMs?: number): Promise<T>;
