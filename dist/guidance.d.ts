export interface DocumentationTopic {
    name: string;
    title: string;
    summary: string;
    usage: string[];
    details: string[];
    examples: string[];
    related: string[];
    url: string;
}
export declare const TOP_LEVEL_COMMANDS: ("plugins" | "profile" | "modules" | "dev" | "databases" | "secrets" | "manifest" | "projects" | "repositories" | "connections" | "previews" | "builds" | "deployments" | "bindings" | "assets" | "organizations" | "templates" | "approvals" | "handoffs" | "policies" | "workloads" | "create" | "update" | "ai" | "auth" | "quickstart" | "init" | "doctor" | "validate" | "test" | "ci" | "functions" | "logs" | "support" | "metrics" | "analytics" | "completion" | "api" | "docs")[];
export declare function documentationIndex(): {
    schema: string;
    cli_version: string;
    documentation_url: string;
    topics: Array<{
        name: string;
        title: string;
        summary: string;
        url: string;
    }>;
};
export declare function documentationTopic(name: string): DocumentationTopic | undefined;
export declare function searchDocumentation(query: string): DocumentationTopic[];
export declare function renderTopic(topic: DocumentationTopic): string;
export declare function renderTopHelp(): string;
export declare function quickstart(path?: string): Promise<Record<string, unknown>>;
