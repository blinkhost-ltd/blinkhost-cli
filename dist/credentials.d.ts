export declare function getRefreshCredential(profile: string): Promise<string | null>;
export declare function setRefreshCredential(profile: string, token: string): Promise<void>;
export declare function deleteRefreshCredential(profile: string): Promise<void>;
