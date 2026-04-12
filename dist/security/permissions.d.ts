import { Permission, SecurityContext } from '../types/index';
export declare class SecurityError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class PermissionGuard {
    private ctx;
    constructor(ctx: SecurityContext);
    enforce(required: Permission): void;
    enforceAll(required: Permission[]): void;
    downscope(subset: Permission[]): SecurityContext;
    get agentId(): string;
    get permissions(): Permission[];
}
export declare function buildContext(agentId: string, permissions: Permission[]): SecurityContext;
//# sourceMappingURL=permissions.d.ts.map