export const EXIT = { success: 0, usage: 2, validation: 3, filesystem: 4, internal: 5, auth: 6, network: 7, remote: 8, conflict: 9 } as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class ManifestError extends CliError {
  constructor(message: string, details: string[] = []) {
    super(message, EXIT.validation, 'manifest_invalid', details);
    this.name = 'ManifestError';
  }
}
