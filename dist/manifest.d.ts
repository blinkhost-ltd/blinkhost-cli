export declare const MANIFEST_SCHEMA = "blinkhost/v1";
export declare const MANIFEST_FILENAME = "blinkhost.yaml";
export declare const MAX_MANIFEST_BYTES: number;
export declare const SUPPORTED_FRONTENDS: readonly ["astro", "html", "react", "solid", "svelte", "vue"];
export declare const SUPPORTED_MANAGERS: readonly ["bun", "npm", "pnpm", "yarn"];
export declare const SUPPORTED_MODULES: readonly ["go", "javascript", "python", "rust", "typescript"];
export type FrontendFramework = typeof SUPPORTED_FRONTENDS[number];
export type PackageManager = typeof SUPPORTED_MANAGERS[number];
export type ModuleLanguage = typeof SUPPORTED_MODULES[number];
export interface BlinkHostManifest {
    schema: typeof MANIFEST_SCHEMA;
    application: {
        root: string;
    };
    frontend: {
        root: string;
        dependency_root: string;
        framework: FrontendFramework;
        package_manager: PackageManager;
        install: string;
        build: string;
        dev: string;
        output: string;
    };
    modules: Array<{
        name: string;
        path: string;
        language: ModuleLanguage;
        entrypoint: string;
        abi: string;
        sdk: string;
    }>;
    resources: {
        databases: Array<{
            binding: string;
            schema?: string;
            migrations?: string;
            seeds?: string;
        }>;
        secrets: string[];
    };
    preview: {
        enabled: boolean;
        database_mode: 'none' | 'isolated_branch';
    };
    ignore: string[];
}
export declare function normalizeRepositoryPath(value: unknown, field: string, allowRoot?: boolean): string;
export declare function parseManifest(raw: string | Uint8Array): BlinkHostManifest;
export declare function serializeManifest(manifest: BlinkHostManifest): string;
