import type { Readable } from 'node:stream';
export declare function readTestCredentialInput(input?: Readable & {
    isTTY?: boolean;
}, timeoutMs?: number): Promise<string>;
export declare function runTestCredentials(input: string[], profile?: string, source?: Readable & {
    isTTY?: boolean;
}): Promise<unknown>;
