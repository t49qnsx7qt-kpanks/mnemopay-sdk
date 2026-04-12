// Platform bridge interface — implemented by NodeBridge (testing/server),
// AndroidBridge (React Native Android), and IOSBridge (React Native iOS).
// The mobile-sdk ships the NodeBridge by default; native bridges are
// registered via MnemoPay.setPlatformBridge() before first use.

export type { PlatformCrypto } from '../security/crypto';
export { NodeCrypto } from '../security/crypto';

export interface DeviceAttestation {
  token: string;       // iOS App Attest assertion / Android Play Integrity JWT
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
  // Returns path to writable SQLite DB (OS-appropriate secure location)
  getDatabasePath(filename: string): string;
}

// ── NodeBridge ─────────────────────────────────────────────────────────────
// Used in Node.js (server-side agents, CLI tools, testing).
// No hardware security — falls back to software crypto.
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from '@noble/ciphers/webcrypto';

export class NodeBridge implements PlatformBridge {
  private readonly _deviceId: string;

  constructor(deviceId?: string) {
    // Stable device ID: derive from hostname + username, or accept explicit
    this._deviceId = deviceId ?? Buffer.from(
      `${os.hostname()}:${os.userInfo().username}`,
    ).toString('hex').slice(0, 32);
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    return {
      deviceId: this._deviceId,
      platform: 'node',
      isRooted: false,
      osVersion: `${os.type()} ${os.release()}`,
      sdkVersion: '0.1.0',
    };
  }

  async getAttestation(_challenge: string): Promise<DeviceAttestation> {
    // No hardware attestation in Node.js — return soft attestation
    return {
      token: Buffer.from(randomBytes(32)).toString('hex'),
      provider: 'none',
      timestamp: Date.now(),
    };
  }

  getDatabasePath(filename: string): string {
    // Store in ~/.mnemopay/ on Node.js
    return path.join(os.homedir(), '.mnemopay', filename);
  }
}

// ── AndroidBridge stub ─────────────────────────────────────────────────────
// Real implementation lives in the React Native native module.
// This stub satisfies TypeScript at build time.
export class AndroidBridge implements PlatformBridge {
  async getDeviceInfo(): Promise<DeviceInfo> {
    throw new Error('AndroidBridge requires React Native native module. Install @mnemopay/react-native.');
  }
  async getAttestation(_challenge: string): Promise<DeviceAttestation> {
    throw new Error('AndroidBridge requires React Native native module.');
  }
  getDatabasePath(filename: string): string {
    // Android: app-private files dir (encrypted by FileVault on Android 10+)
    return `/data/data/com.mnemopay/${filename}`;
  }
}

// ── IOSBridge stub ─────────────────────────────────────────────────────────
export class IOSBridge implements PlatformBridge {
  async getDeviceInfo(): Promise<DeviceInfo> {
    throw new Error('IOSBridge requires React Native native module. Install @mnemopay/react-native.');
  }
  async getAttestation(_challenge: string): Promise<DeviceAttestation> {
    throw new Error('IOSBridge requires React Native native module.');
  }
  getDatabasePath(filename: string): string {
    // iOS: Documents directory (excluded from iCloud backup by default)
    return `~/Documents/MnemoPay/${filename}`;
  }
}
