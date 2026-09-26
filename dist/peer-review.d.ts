export type PeerExpected = {
    project: string;
    task?: string;
    peer?: string;
    reviewer?: number;
    digest?: string;
};
export declare function validatePeerResponse(value: unknown, expected: PeerExpected, action: string): void;
