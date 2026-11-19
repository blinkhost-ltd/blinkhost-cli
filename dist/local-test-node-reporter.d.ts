interface Event {
    type: string;
    data: Record<string, unknown>;
}
/** node:test event adapter. Node execution is native; it never claims browser or WASM coverage. */
export default function blinkhostNodeReporter(source: AsyncIterable<Event>): AsyncGenerator<string>;
export {};
