"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensurePermission = ensurePermission;
const authorization_1 = require("../../application/auth/authorization");
async function ensurePermission(request, reply, permission) {
    const user = request.user;
    if (!user?.sub) {
        reply.code(401).send({ error: 'unauthorized' });
        return false;
    }
    const allowed = await (0, authorization_1.userHasPermission)(user.sub, permission);
    if (!allowed) {
        reply.code(403).send({ error: 'forbidden' });
        return false;
    }
    return true;
}
