export declare function designArguments(args: string[]): {
    project: string;
    body: Record<string, unknown>;
};
export declare function runDesign(args: string[], profile?: string): Promise<unknown>;
