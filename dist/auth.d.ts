export declare function login(options: {
    profile?: string;
    apiOrigin?: string;
    openBrowser?: boolean;
    progress?: (line: string) => void;
}): Promise<unknown>;
export declare function logout(profile?: string): Promise<{
    profile: string;
}>;
