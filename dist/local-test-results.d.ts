export declare const LOCAL_TEST_RESULT_LIMITS: {
    readonly bytes: number;
    readonly totalBytes: number;
    readonly tests: 10000;
};
type Profile = 'native' | 'wasm' | 'browser' | 'unspecified';
export type LocalTestResultStatus = 'passed' | 'failed' | 'no_tests' | 'skipped' | 'unsupported';
export interface LocalTestCounts {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    unsupported: number;
}
interface CoverageMetric {
    covered: number;
    total: number;
}
export interface LocalTestReport {
    schema: 'blinkhost.local-test-results/v1';
    authority: 'customer_runner_reported';
    source_sha256: string;
    source_bytes: number;
    runner: string;
    profile: Profile;
    status: LocalTestResultStatus;
    counts: LocalTestCounts;
    tests: Array<{
        id: string;
        name: string;
        status: 'passed' | 'failed' | 'skipped' | 'unsupported';
        duration_ms?: number;
        message?: string;
        stack?: string;
    }>;
    coverage: {
        status: 'collected' | 'unavailable' | 'not_collected';
        profile: Profile;
        authority: 'customer_runner_reported';
        metrics?: Partial<Record<'lines' | 'branches' | 'functions', CoverageMetric>>;
    };
    sanitization: 'common_credentials_terminal_controls_and_run_context';
}
export interface LocalTestResultSink {
    directory: string;
    path: string;
    runId: string;
    device: number;
    inode: number;
}
export declare function screenLocalTestRunContext(value: string, sink: LocalTestResultSink): string;
/** One new directory and unpredictable run ID per check. Neither is returned in public receipts. */
export declare function createLocalTestResultSink(): Promise<LocalTestResultSink>;
export declare function removeLocalTestResultSink(sink: LocalTestResultSink): Promise<void>;
/** Canonical customer report import, not executor certification or promotion authority. */
export declare function readLocalTestResults(sink: LocalTestResultSink, check: {
    id: string;
    profile: Profile;
}, remainingBytes?: number): Promise<LocalTestReport>;
/** Bounded import of captured runner bytes. This never certifies their truth or grants gate authority. */
export declare function parseLocalTestResults(bytes: Buffer, sink: LocalTestResultSink, check: {
    id: string;
    profile: Profile;
}, remainingBytes?: number): LocalTestReport;
export {};
