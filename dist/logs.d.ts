type Filters = Record<string, string>;
export type LogEvent = Record<string, unknown> & {
    event_id: string;
    event_time: string;
};
export type LogEntry = {
    kind: 'event';
    event: LogEvent;
} | {
    kind: 'notice';
    code: string;
    message: string;
} | {
    kind: 'summary';
    events: number;
    duplicates_skipped: number;
    reason: string;
    filters: Filters;
    has_more: boolean;
    next_cursor: string | null;
};
export interface LogClient {
    request(path: string, init?: RequestInit, responseLimit?: number): Promise<unknown>;
}
export interface LogOptions {
    project?: string;
    filters: Filters;
    follow: boolean;
    maxEvents: number;
    cursor?: string;
}
export declare function sinceFilters(value: string, now?: number, aggregate?: boolean): Filters;
export declare function parseLogOptions(input: string[], now?: number): LogOptions;
export declare function serializeLogEvent(event: LogEvent): string;
export declare function renderLogEntry(entry: LogEntry, json: boolean): string;
/** Stop waiting on a stalled terminal pipe when the user interrupts. */
export declare function writeLogOutput(output: Pick<NodeJS.WriteStream, 'write'>, value: string, signal: AbortSignal): Promise<boolean>;
/** Stream one bounded page at a time; every write is awaited by the caller. */
export declare function readLogs(client: LogClient, options: LogOptions & {
    project: string;
}, emit: (entry: LogEntry, signal: AbortSignal) => Promise<void>, interruptSignal: AbortSignal, pause?: (ms: number, signal: AbortSignal) => Promise<void>): Promise<void>;
export declare function runLogCommand(input: string[], profile: string | undefined, emit: (entry: LogEntry, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void>;
export {};
