/** One command for security's stdin parser, not a shell or process argument. */
export declare function macosKeychainWrite(profile: string, token: string): {
    command: string;
    args: string[];
    input: string;
};
