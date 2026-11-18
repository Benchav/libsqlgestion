"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.presentUser = presentUser;
function resolveRoles(user, roles) {
    if (roles)
        return roles;
    return (user.roles || [])
        .map((entry) => entry?.role?.name || entry?.name)
        .filter((role) => typeof role === 'string' && role.length > 0);
}
function presentUser(user, roles) {
    return {
        id: user.id || user.sub,
        email: user.email,
        active: Boolean(user.active),
        createdAt: user.createdAt,
        roles: resolveRoles(user, roles),
    };
}
