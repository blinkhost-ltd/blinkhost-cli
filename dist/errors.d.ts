export declare const EXIT: {
    readonly success: 0;
    readonly usage: 2;
    readonly validation: 3;
    readonly filesystem: 4;
    readonly internal: 5;
};
export declare class CliError extends Error {
    readonly exitCode: number;
    readonly code: string;
    readonly details: string[];
    constructor(message: string, exitCode: number, code: string, details?: string[]);
}
export declare class ManifestError extends CliError {
    constructor(message: string, details?: string[]);
}
