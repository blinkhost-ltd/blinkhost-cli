export type LocalDevWriter = (value: string, signal: AbortSignal) => Promise<boolean>;
/** One foreground owner for the packaged local tool; no remote account APIs. */
export declare function runLocalDev(root: string, config: string, state: string, json: boolean, write?: LocalDevWriter, watchArtifact?: boolean, sourceBuildConfig?: string, watchSource?: boolean): Promise<unknown>;
