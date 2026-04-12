export interface PlatformCrypto {
    sign(data: Uint8Array): Promise<Uint8Array>;
    verify(data: Uint8Array, sig: Uint8Array, pubKey: Uint8Array): Promise<boolean>;
    getPublicKey(): Uint8Array;
    encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
    decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
    hmac(data: Uint8Array): Promise<Uint8Array>;
    verifyHmac(data: Uint8Array, mac: Uint8Array): Promise<boolean>;
}
export declare class NodeCrypto implements PlatformCrypto {
    private signingKey;
    private encKey;
    private macKey;
    private pubKey;
    constructor(encKey?: Uint8Array, macKey?: Uint8Array, signingKey?: Uint8Array);
    getPublicKey(): Uint8Array;
    sign(data: Uint8Array): Promise<Uint8Array>;
    verify(data: Uint8Array, sig: Uint8Array, pubKey: Uint8Array): Promise<boolean>;
    encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
    decrypt(encrypted: Uint8Array): Promise<Uint8Array>;
    hmac(data: Uint8Array): Promise<Uint8Array>;
    verifyHmac(data: Uint8Array, mac: Uint8Array): Promise<boolean>;
}
export declare function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean;
export declare function hashBytes(data: Uint8Array): string;
export declare function hashString(str: string): string;
export declare function generateId(prefix: string): string;
//# sourceMappingURL=crypto.d.ts.map