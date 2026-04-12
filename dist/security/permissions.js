"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionGuard = exports.SecurityError = void 0;
exports.buildContext = buildContext;
const webcrypto_1 = require("@noble/ciphers/webcrypto");
class SecurityError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SecurityError';
    }
}
exports.SecurityError = SecurityError;
class PermissionGuard {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    enforce(required) {
        if (Date.now() > this.ctx.expiresAt) {
            throw new SecurityError('SESSION_EXPIRED', 'Security context has expired');
        }
        if (!this.ctx.permissions.includes(required)) {
            throw new SecurityError('PERMISSION_DENIED', `Missing permission: ${required}`);
        }
    }
    enforceAll(required) {
        for (const p of required)
            this.enforce(p);
    }
    // Create a reduced-privilege context for sub-agents.
    // Cannot grant any permission not already held — throws on escalation attempt.
    downscope(subset) {
        for (const p of subset) {
            if (!this.ctx.permissions.includes(p)) {
                throw new SecurityError('ESCALATION_BLOCKED', `Cannot grant unheld permission: ${p}`);
            }
        }
        return {
            ...this.ctx,
            permissions: subset,
            sessionKey: (0, webcrypto_1.randomBytes)(32),
            expiresAt: Math.min(this.ctx.expiresAt, Date.now() + 5 * 60 * 1000), // 5 min cap
        };
    }
    get agentId() { return this.ctx.agentId; }
    get permissions() { return [...this.ctx.permissions]; }
}
exports.PermissionGuard = PermissionGuard;
function buildContext(agentId, permissions) {
    const defaultRateLimit = {
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
        sessionKey: (0, webcrypto_1.randomBytes)(32),
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    };
}
//# sourceMappingURL=permissions.js.map