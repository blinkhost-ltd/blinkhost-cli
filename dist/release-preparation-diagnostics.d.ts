import type { ApiClient } from './api.js';
export interface PreparationRelease {
    id: string;
    artifact_digest: string;
    backend_modules_digest: string;
    environment: {
        root_project_id: string;
    };
    backend_modules_snapshot: Array<{
        module_id: string;
        name: string;
        artifact_digest: string;
        artifact_size_bytes: number;
    }>;
}
export interface PreparationAttempt {
    preparationId: string;
    moduleName: string;
    recordedAt: string;
    explanation: string;
}
export interface ReleasePreparationDiagnostics {
    state: 'available' | 'unavailable';
    attempts: PreparationAttempt[];
    truncated: boolean;
}
export declare function parseReleasePreparationDiagnostics(value: unknown, release: PreparationRelease): ReleasePreparationDiagnostics | undefined;
export declare function isPreparationDiagnosticsRead(path: string): boolean;
export declare function readPreparationDiagnosticsResponse(response: Response, limit: number): Promise<unknown>;
export declare function loadReleasePreparationDiagnostics(client: ApiClient, id: string, project: string): Promise<{
    deploymentId: string;
    projectId: string;
    kind: 'recorded_attempt_failures';
    explanation: string;
    state: ReleasePreparationDiagnostics['state'];
    attempts: PreparationAttempt[];
    truncated: boolean;
}>;
