import { CliError } from './errors.js';
export declare const LOCAL_TEST_LIMITS: {
    readonly timeoutMs: 900000;
    readonly maxTimeoutMs: 3600000;
    readonly maxOutputBytes: number;
    readonly maximumOutputBytes: number;
    readonly terminationGraceMs: 1000;
};
export interface LocalTestCommandResult {
    status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'output_limit' | 'unavailable';
    exit_code: number | null;
    signal: NodeJS.Signals | null;
    duration_ms: number;
    observed_output_bytes: number;
    captured_output_bytes: number;
    output: {
        stdout: string;
        stderr: string;
        sanitization: 'common_credentials_and_terminal_controls';
    };
    limits: {
        timeout_ms: number;
        max_output_bytes: number;
        termination_grace_ms: number;
    };
    cleanup: {
        scope: 'posix_process_group' | 'direct_child';
        kill_requested: boolean;
    };
}
export declare class LocalTestChecksFailure extends CliError {
    readonly projectChecks?: unknown | undefined;
    constructor(message: string, exitCode: number, code: string, details?: string[], projectChecks?: unknown | undefined);
}
export declare class LocalTestCommandFailure extends LocalTestChecksFailure {
    readonly execution: LocalTestCommandResult;
    constructor(message: string, exitCode: number, code: string, execution: LocalTestCommandResult, details?: string[], projectChecks?: unknown);
}
/** Heuristic screening of local diagnostics, not a guarantee that output is secret-free. */
export declare function sanitizeLocalTestOutput(value: string): string;
/** Local customer commands only. Process groups are cleanup scope, not a security sandbox. */
export declare function runLocalTestCommand(command: string, args: string[], options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
    terminationGraceMs?: number;
    signal?: AbortSignal;
}): Promise<LocalTestCommandResult>;
