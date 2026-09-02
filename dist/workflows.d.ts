export declare function runDev(input: string[], json?: boolean): Promise<unknown>;
export declare function testProject(input: string[], json?: boolean): Promise<unknown>;
export declare function observability(kind: 'logs' | 'metrics' | 'analytics', input: string[], profile?: string): Promise<unknown>;
export declare function runPlugins(input: string[], json?: boolean): Promise<unknown>;
export declare function completion(shell: string | undefined): string;
interface ReleaseCheck {
    current_version: string;
    latest_version: string | null;
    update_available: boolean;
    affected?: boolean;
    impact?: string;
    requires_action?: boolean;
    summary?: string;
    release_url?: string;
    migration_url?: string;
    install_command?: string;
    automatic_install: false;
}
export declare function checkForUpdate(profile?: string, timeoutMs?: number): Promise<ReleaseCheck>;
export declare function releaseNotes(version?: string, profile?: string): Promise<unknown>;
export declare function maybeUpdateNotice(profile?: string): Promise<string | null>;
export declare function ciCheck(profile?: string): Promise<unknown>;
export declare function supportBundle(input: string[], profile?: string): Promise<unknown>;
export {};
