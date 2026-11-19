import { type LocalDevWriter } from './local-dev.js';
import { type LocalTestCommandResult } from './local-test-command.js';
import { type LocalCheckDefinition, type LocalProjectDiscovery } from './local-test-config.js';
import { type LocalTestGateReceipt } from './local-test-gates.js';
import { type LocalTestReport, type LocalTestCounts } from './local-test-results.js';
export declare function runDev(input: string[], json?: boolean, write?: LocalDevWriter): Promise<unknown>;
export interface LocalProjectCheckResult {
    schema: 'blinkhost.local-project-checks/v1';
    validated: true;
    status: 'validation_only' | 'build_only' | 'test_command_succeeded' | 'checks_succeeded' | 'tests_passed' | 'no_tests' | 'skipped' | 'unsupported';
    command?: string;
    exit_code?: number;
    build?: 'not_required';
    tests_executed: number | null;
    test_evidence: 'not_run' | 'command_exit_only' | 'customer_runner_reported' | 'mixed';
    test_counts?: LocalTestCounts;
    coverage: {
        native: 'not_collected' | 'customer_runner_reported';
        wasm: 'not_collected' | 'customer_runner_reported';
    };
    backend_modules: Array<{
        name: string;
        path: string;
        language: string;
        status: 'not_run' | 'test_command_succeeded' | 'tests_passed' | 'no_tests' | 'skipped' | 'unsupported' | 'build_only' | 'failed';
    }>;
    execution?: LocalTestCommandResult;
    configuration: 'explicit' | 'frontend_default' | 'none';
    discovery: LocalProjectDiscovery;
    checks: Array<Omit<LocalCheckDefinition, 'command' | 'args'> & {
        status: LocalTestCommandResult['status'] | 'not_run';
        execution?: LocalTestCommandResult;
        report?: LocalTestReport;
        report_error?: string;
    }>;
    local_gate?: LocalTestGateReceipt;
}
export declare function localProjectCheckMessage(result: LocalProjectCheckResult): string;
export declare function testProject(input: string[], _json?: boolean, signal?: AbortSignal): Promise<LocalProjectCheckResult>;
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
