export declare const starterName: (value: unknown) => value is string;
export declare const starterLanguage: (value: unknown) => value is string;
export type StarterExpected = {
    project: string;
    review?: string;
    name?: string;
    language?: string;
    revision?: string;
    digest?: string;
};
export declare function validateStarter(value: unknown, expected: StarterExpected, action: string): void;
