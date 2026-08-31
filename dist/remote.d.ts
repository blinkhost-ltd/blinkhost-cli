export declare function runRemote(group: string, input: string[], profile?: string): Promise<unknown>;
export declare function runFunctions(input: string[], profile?: string): Promise<unknown>;
interface ProjectLink {
    schema: 'blinkhost/project-link/v1';
    project_id: string;
    profile: string;
}
export declare function writeProjectLink(projectId: string, profile: string, root?: string): Promise<ProjectLink>;
export declare function readProjectLink(root?: string): Promise<ProjectLink>;
export declare function unlinkProject(root?: string): Promise<{
    unlinked: boolean;
}>;
export declare function projectStatus(profile?: string): Promise<unknown>;
export declare function syncProject(kind: 'pull' | 'push', input: string[], profile?: string): Promise<unknown>;
export declare function runSecrets(input: string[], profile?: string): Promise<unknown>;
export declare function rawApi(input: string[], profile?: string): Promise<unknown>;
export declare function waitForRemote(group: 'builds' | 'deployments' | 'previews', input: string[], profile?: string): Promise<unknown>;
export declare function openPreview(input: string[], profile?: string, launchBrowser?: boolean): Promise<unknown>;
export declare function uploadAsset(input: string[], profile?: string): Promise<unknown>;
export {};
