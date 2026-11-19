import { type BlinkHostManifest } from './manifest.js';
export declare const LOCAL_TEST_CONFIG = "blinkhost.tests.json";
export declare const TEST_DISCOVERY_LIMITS: {
    readonly directories: 2048;
    readonly entries: 16384;
    readonly depth: 8;
    readonly projects: 128;
};
export interface LocalCheckDefinition {
    id: string;
    target: string;
    cwd: string;
    command: string;
    args: string[];
    kind: 'test' | 'integration' | 'build';
    profile: 'native' | 'wasm' | 'browser' | 'unspecified';
    results?: {
        format: 'blinkhost/v1';
    };
    runner?: 'node' | 'python-unittest' | 'go' | 'rust';
}
/** Customer-selected paths stay inside the project and cannot traverse existing symlinks. */
export declare function localCheckDirectory(root: string, value: unknown): Promise<string>;
export declare function readLocalTestConfig(root: string, manifest: BlinkHostManifest): Promise<LocalCheckDefinition[] | null>;
export interface LocalProjectDiscovery {
    nested_projects: Array<{
        path: string;
        status: 'not_run';
        reason: 'run_explicitly' | 'unsafe_manifest';
    }>;
    complete: boolean;
    directories_scanned: number;
    entries_scanned: number;
    limits: typeof TEST_DISCOVERY_LIMITS;
}
/** Discover only project manifests, never install dependencies or execute discovered projects. */
export declare function discoverLocalProjects(root: string, signal?: AbortSignal): Promise<LocalProjectDiscovery>;
