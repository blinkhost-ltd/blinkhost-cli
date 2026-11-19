interface Context {
    path: string;
    runId: string;
    checkId: string;
}
interface TestRow {
    id: string;
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    message?: string;
}
/** Pinned stable libtest census: unsupported/custom output fails closed. */
export declare function rustTestCensus(output: string): string[];
/** Reconciles every selected test, native exit and the stable libtest summary. */
export declare function rustTestResults(output: string, names: string[], ignored: Set<string>, exitCode: number, ctx: Context): Omit<TestRow, 'id'>[];
/** Stable native Cargo/libtest adapter. Cargo build scripts/tests use local customer permissions. */
export declare function runRustTests(args: string[]): Promise<number>;
export {};
