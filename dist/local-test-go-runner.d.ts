interface TestRow {
    id: string;
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    duration_ms: number;
    message?: string;
}
interface Context {
    path: string;
    runId: string;
    checkId: string;
}
/** Consumes actual go test -json events. Package checks are never invented application tests. */
export declare class GoTestEvents {
    private readonly ctx;
    readonly tests: TestRow[];
    private packages;
    private startedTests;
    private diagnosticBytes;
    private buildFailed;
    constructor(ctx: Context);
    accept(value: unknown): string | undefined;
    finish(exitCode: number): TestRow[];
}
/** Native test execution only. Parent CLI owns timeout, output budget and process-group cleanup. */
export declare function runGoTests(args: string[]): Promise<number>;
export {};
