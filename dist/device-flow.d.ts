import { publicRequest } from './api.js';
type DevicePolling = {
    device_code: string;
    expires_in: number;
    interval: number;
};
type DeviceAuthorization = DevicePolling & {
    user_code: string;
    verification_uri_complete: string;
};
type PollingServices = {
    request: typeof publicRequest;
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
};
/** Validate the server contract before displaying terminal text or launching a browser. */
export declare function validateDeviceAuthorization(data: unknown): DeviceAuthorization;
export declare function validateDeviceTokens(data: unknown): {
    access_token: string;
    refresh_token: string;
};
/** Pending authorization is safe to poll; token delivery and network failures are not retried. */
export declare function pollDeviceAuthorization(apiOrigin: string, device: DevicePolling, verifier: string, dependencies?: PollingServices): Promise<unknown>;
export {};
