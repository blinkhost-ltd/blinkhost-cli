export declare const EXIT: {
    readonly success: 0;
    readonly usage: 2;
    readonly validation: 3;
    readonly filesystem: 4;
    readonly internal: 5;
    readonly auth: 6;
    readonly network: 7;
    readonly remote: 8;
    readonly conflict: 9;
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
