import { Permission, SecurityContext, RateLimitConfig } from '../types/index';
import { randomBytes } from '@noble/ciphers/webcrypto';

export class SecurityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

export class PermissionGuard {
  constructor(private ctx: SecurityContext) {}

  enforce(required: Permission): void {
    if (Date.now() > this.ctx.expiresAt) {
      throw new SecurityError('SESSION_EXPIRED', 'Security context has expired');
    }
    if (!this.ctx.permissions.includes(required)) {
      throw new SecurityError('PERMISSION_DENIED', `Missing permission: ${required}`);
    }
  }

  enforceAll(required: Permission[]): void {
    for (const p of required) this.enforce(p);
  }

  // Create a reduced-privilege context for sub-agents.
  // Cannot grant any permission not already held — throws on escalation attempt.
  downscope(subset: Permission[]): SecurityContext {
    for (const p of subset) {
      if (!this.ctx.permissions.includes(p)) {
        throw new SecurityError('ESCALATION_BLOCKED', `Cannot grant unheld permission: ${p}`);
      }
    }
    return {
      ...this.ctx,
      permissions: subset,
      sessionKey: randomBytes(32),
      expiresAt: Math.min(this.ctx.expiresAt, Date.now() + 5 * 60 * 1000), // 5 min cap
    };
  }

  get agentId(): string { return this.ctx.agentId; }
  get permissions(): Permission[] { return [...this.ctx.permissions]; }
}

export function buildContext(agentId: string, permissions: Permission[]): SecurityContext {
  const defaultRateLimit: RateLimitConfig = {
    generalPerMin: 60,
    memoryWritesPerHour: 200,
    transactionsPerHour: 50,
    spatialProofsPerHour: 30,
    burstAllowance: 10,
  };
  return {
    agentId,
    permissions,
    rateLimit: defaultRateLimit,
    sessionKey: randomBytes(32),
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  };
}
