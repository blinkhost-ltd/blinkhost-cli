export declare function runDev(input: string[], json?: boolean): Promise<unknown>;
export declare function testProject(input: string[], json?: boolean): Promise<unknown>;
export declare function observability(kind: 'logs' | 'metrics' | 'analytics', input: string[], profile?: string): Promise<unknown>;
export declare function runPlugins(input: string[], json?: boolean): Promise<unknown>;
export declare function completion(shell: string | undefined): string;
export declare function checkForUpdate(): Promise<unknown>;
export declare function ciCheck(profile?: string): Promise<unknown>;
export declare function supportBundle(input: string[], profile?: string): Promise<unknown>;
