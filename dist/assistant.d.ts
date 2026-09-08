export declare function readAssistantRequest(path: string | undefined): Promise<Record<string, unknown>>;
export declare function readWorkflowPlan(path: string | undefined): Promise<Record<string, unknown>>;
export declare function readProjectGuidance(path: string | undefined): Promise<string>;
export declare function runAssistant(input: string[], profile?: string): Promise<{
    message: string;
    data: unknown;
}>;
