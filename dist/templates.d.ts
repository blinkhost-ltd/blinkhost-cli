import type { BlinkHostManifest, FrontendFramework, ModuleLanguage, PackageManager } from './manifest.js';
export interface ScaffoldModule {
    name: string;
    language: ModuleLanguage;
}
export interface ScaffoldOptions {
    name: string;
    framework: FrontendFramework;
    packageManager: PackageManager;
    modules: ScaffoldModule[];
    database?: string;
}
export interface Scaffold {
    manifest: BlinkHostManifest;
    files: Map<string, string>;
}
export declare function createScaffold(options: ScaffoldOptions): Scaffold;
