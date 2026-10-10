export declare const SEO_VERSION = "blinkhost-seo/v1";
export declare const SEO_RULESET = "2026-10-05.1";
export interface LocalFinding {
    key: string;
    rule: string;
    rule_version: string;
    path: string;
    severity: string;
    confidence: string;
    evidence: Record<string, unknown>;
    remedy: string;
    source: string;
    state: string;
    content_is_untrusted: boolean;
}
export declare function checkLocalHtml(html: string, path: string, source: string): LocalFinding[];
export declare function localAudit(directory: string, gate?: boolean): Promise<Record<string, unknown>>;
export declare function runSeo(args: string[], profile?: string): Promise<Record<string, unknown>>;
