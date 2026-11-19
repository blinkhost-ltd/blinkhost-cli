import { type LocalSourceBuildReceipt } from './local-source-build.js';
export interface LocalSourceRebuildEvent {
    schema: 'blinkhost.local-source-rebuild/v1';
    status: 'reloaded' | 'unchanged' | 'rejected';
    attempt: number;
    error?: string;
    build?: LocalSourceBuildReceipt;
    reload?: unknown;
    previous_runtime_retained: boolean;
    watching_stopped?: boolean;
    production_authority: false;
}
export interface LocalSourcePublication {
    status: 'reloaded' | 'unchanged' | 'rejected';
    error?: string;
    [key: string]: unknown;
}
/** Serial, bounded rebuilds. No overlapping compilers or inferred source/configuration discovery. */
export declare function watchLocalSource(root: string, filename: string, directory: string, initial: LocalSourceBuildReceipt, publish: (build: LocalSourceBuildReceipt, verifyCandidate: () => Promise<void>) => Promise<LocalSourcePublication>, runtimeAvailable: () => boolean, onEvent: (event: LocalSourceRebuildEvent) => Promise<void>, { signal, pollMs, maxBuilds, maxEvents }: {
    signal: AbortSignal;
    pollMs?: number;
    maxBuilds?: number;
    maxEvents?: number;
}): Promise<void>;
