import { type LocalTestCommandResult } from './local-test-command.js';
export declare const LOCAL_SOURCE_LIMITS: {
    readonly configBytes: 65536;
    readonly files: 1024;
    readonly sourceBytes: number;
    readonly executableBytes: number;
    readonly artifactBytes: 20000000;
    readonly timeoutMs: 300000;
    readonly maxTimeoutMs: 900000;
    readonly outputBytes: 1048576;
};
export interface LocalSourceBuildReceipt {
    schema: 'blinkhost.local-source-build-result/v1';
    status: 'compiled' | 'rejected';
    config_sha256: string;
    command_sha256: string;
    source_sha256: Record<string, string>;
    artifact: {
        path: string;
        sha256: string;
        bytes: number;
    } | null;
    execution: LocalTestCommandResult | null;
    error?: string;
    validation: 'portable_header_only';
    sandbox: 'customer_command_no_sandbox';
    production_authority: false;
}
export declare function readSourceStackConfiguration(filename: string): Promise<{
    value: Record<string, unknown>;
    sha256: string;
}>;
/** Compile one explicit, immutable source snapshot. Commands are trusted customer code. */
export declare function buildLocalSource(root: string, filename: string, directory: string, { signal }?: {
    signal?: AbortSignal;
}): Promise<LocalSourceBuildReceipt>;
/** Watch only the initial explicit input list; build configuration changes require a new run. */
export declare function fingerprintLocalSource(root: string, filename: string, baseline: LocalSourceBuildReceipt, signal?: AbortSignal): Promise<string>;
export declare function localSourceFingerprint(hashes: Record<string, string>): string;
