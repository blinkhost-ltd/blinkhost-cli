export declare function runMigrations(args: string[], profile?: string): Promise<{
    verification?: string;
    migration_id: string;
    status: string;
    phase: string;
    checksum: string | null;
} | {
    review: {
        identity: {
            database_id: string;
            binding_id: string;
            generation: string;
        };
        before_sha256: string;
        after_sha256: string;
        schema_sources: {
            [k: string]: string | null;
        };
        target_schema_sql: string;
        source_path?: string | undefined;
        project: {
            id: string;
            name: string;
        };
        migration_id: string;
        environment: string;
        version: number;
        checksum: string;
        sql: string;
    };
    review_sha256: string;
    api_origin: string;
    organization_id: string;
    migration_id: string;
    status: string;
}>;
