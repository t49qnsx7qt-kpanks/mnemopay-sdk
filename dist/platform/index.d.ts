export type { PlatformCrypto } from '../security/crypto';
export { NodeCrypto } from '../security/crypto';
export interface DeviceAttestation {
    token: string;
    provider: 'apple' | 'google' | 'none';
    timestamp: number;
}
export interface DeviceInfo {
    deviceId: string;
    platform: 'ios' | 'android' | 'node';
    isRooted: boolean;
    osVersion: string;
    sdkVersion: string;
}
export interface PlatformBridge {
    getDeviceInfo(): Promise<DeviceInfo>;
    getAttestation(challenge: string): Promise<DeviceAttestation>;
    getDatabasePath(filename: string): string;
}
export declare class NodeBridge implements PlatformBridge {
    private readonly _deviceId;
    constructor(deviceId?: string);
    getDeviceInfo(): Promise<DeviceInfo>;
    getAttestation(_challenge: string): Promise<DeviceAttestation>;
    getDatabasePath(filename: string): string;
}
export declare class AndroidBridge implements PlatformBridge {
    getDeviceInfo(): Promise<DeviceInfo>;
    getAttestation(_challenge: string): Promise<DeviceAttestation>;
    getDatabasePath(filename: string): string;
}
export declare class IOSBridge implements PlatformBridge {
    getDeviceInfo(): Promise<DeviceInfo>;
    getAttestation(_challenge: string): Promise<DeviceAttestation>;
    getDatabasePath(filename: string): string;
}
//# sourceMappingURL=index.d.ts.map