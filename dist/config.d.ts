export declare const DEFAULT_API_ORIGIN = "https://api.blinkhost.me";
export interface Profile {
    apiOrigin: string;
    username?: string;
    userId?: number;
}
export interface PluginRecord {
    executable: string;
    sha256: string;
    addedAt: string;
}
export interface CliConfig {
    activeProfile: string;
    profiles: Record<string, Profile>;
    plugins?: Record<string, PluginRecord>;
    updateCheckedAt?: string;
    latestVersion?: string;
}
export declare function configPath(): string;
export declare function validateProfileName(value: string): string;
export declare function validateApiOrigin(value: string): string;
export declare function readConfig(): Promise<CliConfig>;
export declare function writeConfig(config: CliConfig): Promise<void>;
export declare function activeProfile(explicit?: string): Promise<{
    name: string;
    profile: Profile;
    config: CliConfig;
}>;
