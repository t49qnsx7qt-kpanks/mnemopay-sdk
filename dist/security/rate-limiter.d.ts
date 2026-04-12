import { FraudSignal } from '../types/index';
type Category = 'general' | 'memory_write' | 'transaction' | 'spatial';
export declare class RateLimiter {
    private state;
    private getWindow;
    private refill;
    check(agentId: string, cat: Category): {
        allowed: boolean;
        signal: FraudSignal | null;
    };
    reset(agentId: string): void;
}
export {};
//# sourceMappingURL=rate-limiter.d.ts.map