import { type Profile } from './config.js';
export declare function publicRequest(apiOrigin: string, path: string, init?: RequestInit): Promise<{
    response: Response;
    data: unknown;
}>;
export declare class ApiClient {
    readonly profileName: string;
    readonly profile: Profile;
    private readonly ephemeral;
    private accessToken;
    private constructor();
    static create(profileName?: string): Promise<ApiClient>;
    static fromAccessToken(profileName: string, profile: Profile, accessToken: string): ApiClient;
    projectArchive(projectId: string, mode?: 'portable' | 'source'): Promise<Buffer>;
    request(path: string, init?: RequestInit): Promise<unknown>;
    rememberIdentity(identity: {
        id?: number;
        username?: string;
    }): Promise<void>;
}
export declare function encodeQuery(values: Record<string, string | undefined>): string;
