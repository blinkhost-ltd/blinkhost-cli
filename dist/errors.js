export const EXIT = { success: 0, usage: 2, validation: 3, filesystem: 4, internal: 5, auth: 6, network: 7, remote: 8, conflict: 9 };
export class CliError extends Error {
    exitCode;
    code;
    details;
    constructor(message, exitCode, code, details = []) {
        super(message);
        this.exitCode = exitCode;
        this.code = code;
        this.details = details;
        this.name = 'CliError';
    }
}
export class ManifestError extends CliError {
    constructor(message, details = []) {
        super(message, EXIT.validation, 'manifest_invalid', details);
        this.name = 'ManifestError';
    }
}
//# sourceMappingURL=errors.js.map