import { type BlinkHostManifest } from './manifest.js';
export interface ValidationResult {
    manifest: BlinkHostManifest;
    errors: string[];
    warnings: string[];
}
export declare function resolveLocalPath(input: string | undefined): string;
export declare function readProjectManifest(root: string): Promise<BlinkHostManifest>;
export declare function validateProject(root: string): Promise<ValidationResult>;
export declare function writeScaffoldAtomically(target: string, files: Map<string, string>, manifest: BlinkHostManifest): Promise<void>;
export declare function writeManifest(root: string, manifest: BlinkHostManifest, force: boolean): Promise<void>;
export declare function directoryEntries(root: string): Promise<string[]>;
export declare function temporaryProjectRoot(): string;
