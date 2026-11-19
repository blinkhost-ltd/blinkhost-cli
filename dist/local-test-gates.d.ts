import { type LocalCheckDefinition } from './local-test-config.js';
import type { LocalTestCommandResult } from './local-test-command.js';
import type { LocalTestReport } from './local-test-results.js';
export declare const LOCAL_TEST_GATE_CONFIG = "blinkhost.gates.json";
export declare const LOCAL_TEST_GATE_LIMITS: {
    readonly files: 1024;
    readonly bytes: number;
    readonly fileBytes: number;
};
declare const CATEGORIES: readonly ["source", "artifacts", "dependencies", "runtime", "resources", "fixtures"];
type Category = typeof CATEGORIES[number];
type Stage = 'preview' | 'promotion';
type Check = {
    id: string;
    kind: LocalCheckDefinition['kind'];
    status: LocalTestCommandResult['status'] | 'not_run';
    report?: LocalTestReport;
    report_error?: string;
};
type Input = {
    category: Category | 'configuration' | 'cli';
    path: string;
    sha256: string;
    bytes: number;
};
export interface LocalTestGateReceipt {
    schema: 'blinkhost.local-test-gate/v1';
    stage: Stage;
    status: 'passed' | 'blocked';
    authority: 'customer_runner_reported';
    scope: 'declared_local_inputs';
    production_authority: false;
    input_sha256: string;
    observed_input_sha256: string | null;
    inputs_unchanged: boolean | null;
    inputs: Input[];
    checks: Array<{
        id: string;
        status: 'passed' | 'blocked';
        reason: string | null;
    }>;
    reason: string | null;
}
export interface PreparedLocalTestGate {
    root: string;
    stage: Stage;
    required: string[];
    paths: Array<{
        category: Input['category'];
        path: string;
        filename: string;
    }>;
    inputs: Input[];
    digest: string;
    context: string;
    executables: Array<{
        command: string;
        cwd: string;
        filename: string;
    }>;
}
/** Bind configuration observed before validation to configuration used for execution. */
export declare function captureLocalTestGateConfiguration(root: string, deadline: number, signal?: AbortSignal): Promise<Input[]>;
/** A customer-local preflight, never a worker attestation or preview/promotion grant. */
export declare function prepareLocalTestGate(root: string, stage: string, definitions: LocalCheckDefinition[], limits: {
    timeout_ms: number;
    max_output_bytes: number;
}, deadline: number, signal?: AbortSignal, configuration?: Input[]): Promise<PreparedLocalTestGate>;
export declare function blockedLocalTestGate(prepared: PreparedLocalTestGate, checks: Check[], reason: string): LocalTestGateReceipt;
export declare function finishLocalTestGate(prepared: PreparedLocalTestGate, checks: Check[], deadline: number, signal?: AbortSignal): Promise<LocalTestGateReceipt>;
export {};
