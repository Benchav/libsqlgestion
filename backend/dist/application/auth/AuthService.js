"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const User_1 = require("../../domain/entities/User");
const Session_1 = require("../../domain/entities/Session");
const UserRole_1 = require("../../domain/entities/UserRole");
const Role_1 = require("../../domain/entities/Role");
const password_1 = require("../../infrastructure/security/password");
const tokens_1 = require("../../infrastructure/security/tokens");
const typeorm_1 = require("typeorm");
function authError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}
class AuthService {
    constructor() {
        this.userRepo = data_source_1.AppDataSource.getRepository(User_1.User);
        this.sessionRepo = data_source_1.AppDataSource.getRepository(Session_1.Session);
        this.roleRepo = data_source_1.AppDataSource.getRepository(Role_1.Role);
        this.userRoleRepo = data_source_1.AppDataSource.getRepository(UserRole_1.UserRole);
    }
    async register(email, password) {
        const existing = await this.userRepo.findOneBy({ email });
        if (existing)
            throw new Error('Email already registered');
        if (!(await this.isRegistrationAllowed())) {
            throw new Error('Public registration is disabled');
        }
        const passwordHash = await (0, password_1.hashPassword)(password);
        const user = await this.userRepo.save(this.userRepo.create({ email, passwordHash, active: true }));
        const defaultRoleName = await this.resolveDefaultRoleName();
        const defaultRole = await this.roleRepo.findOneBy({ name: defaultRoleName });
        if (defaultRole) {
            await this.userRoleRepo.save(this.userRoleRepo.create({ user, role: defaultRole }));
        }
        return user;
    }
    async isRegistrationAllowed() {
        const usersCount = await this.userRepo.count();
        if (usersCount === 0)
            return true;
        return String(process.env.ALLOW_PUBLIC_REGISTRATION || 'true').toLowerCase() === 'true';
    }
    async resolveDefaultRoleName() {
        if (process.env.DEFAULT_USER_ROLE) {
            return process.env.DEFAULT_USER_ROLE;
        }
        const adminRole = await this.roleRepo.findOneBy({ name: 'admin' });
        const superadminRole = await this.roleRepo.findOneBy({ name: 'superadmin' });
        const adminCount = adminRole ? await this.userRoleRepo.count({ where: { role: { id: adminRole.id } } }) : 0;
        const superadminCount = superadminRole ? await this.userRoleRepo.count({ where: { role: { id: superadminRole.id } } }) : 0;
        const privilegedCount = adminCount + superadminCount;
        if (privilegedCount === 0) {
            return 'admin';
        }
        return 'readonly';
    }
    async authenticate(email, password) {
        const user = await this.userRepo.findOneBy({ email });
        if (!user || !user.active)
            return null;
        return (await (0, password_1.verifyPassword)(user.passwordHash, password)) ? user : null;
    }
    async changeEmail(userId, currentPassword, email) {
        const user = await this.userRepo.findOneBy({ id: userId });
        if (!user)
            throw authError(404, 'user not found');
        if (!(await (0, password_1.verifyPassword)(user.passwordHash, currentPassword))) {
            throw authError(401, 'invalid current password');
        }
        const normalizedEmail = email.trim();
        const existing = await this.userRepo.findOneBy({ email: normalizedEmail });
        if (existing && existing.id !== user.id) {
            throw authError(409, 'email already registered');
        }
        user.email = normalizedEmail;
        return this.userRepo.save(user);
    }
    async changePassword(userId, currentPassword, newPassword, currentAccessToken) {
        const user = await this.userRepo.findOneBy({ id: userId });
        if (!user)
            throw authError(404, 'user not found');
        if (!(await (0, password_1.verifyPassword)(user.passwordHash, currentPassword))) {
            throw authError(401, 'invalid current password');
        }
        user.passwordHash = await (0, password_1.hashPassword)(newPassword);
        await this.userRepo.save(user);
        await this.revokeUserSessions(user.id, currentAccessToken);
        return user;
    }
    async createUser(email, password, roleName = 'readonly') {
        const normalizedEmail = email.trim();
        const existing = await this.userRepo.findOneBy({ email: normalizedEmail });
        if (existing)
            throw authError(409, 'email already registered');
        const role = await this.roleRepo.findOneBy({ name: roleName });
        if (!role)
            throw authError(422, `role not found: ${roleName}`);
        const passwordHash = await (0, password_1.hashPassword)(password);
        const user = await this.userRepo.save(this.userRepo.create({
            email: normalizedEmail,
            passwordHash,
            active: true,
        }));
        await this.userRoleRepo.save(this.userRoleRepo.create({ user, role }));
        return user;
    }
    async adminUpdateUser(userId, input) {
        const user = await this.userRepo.findOneBy({ id: userId });
        if (!user)
            throw authError(404, 'user not found');
        if (input.email) {
            const normalizedEmail = input.email.trim();
            const existing = await this.userRepo.findOneBy({ email: normalizedEmail });
            if (existing && existing.id !== user.id) {
                throw authError(409, 'email already registered');
            }
            user.email = normalizedEmail;
        }
        if (input.password) {
            user.passwordHash = await (0, password_1.hashPassword)(input.password);
        }
        if (typeof input.active === 'boolean') {
            user.active = input.active;
        }
        await this.userRepo.save(user);
        if (input.password || input.active === false) {
            await this.revokeUserSessions(user.id);
        }
        return user;
    }
    async getUserWithRoles(userId) {
        return this.userRepo.findOne({
            where: { id: userId },
            relations: ['roles', 'roles.role'],
        });
    }
    async revokeUserSessions(userId, keepAccessToken) {
        const query = this.sessionRepo
            .createQueryBuilder()
            .update()
            .set({ revokedAt: new Date() })
            .where('userId = :userId', { userId });
        if (keepAccessToken) {
            query.andWhere('accessTokenHash != :keepAccessTokenHash', {
                keepAccessTokenHash: (0, tokens_1.hashToken)(keepAccessToken),
            });
        }
        await query.execute();
    }
    async issueSession(user) {
        const accessToken = (0, tokens_1.randomToken)();
        const refreshToken = (0, tokens_1.randomToken)();
        const accessTokenHash = (0, tokens_1.hashToken)(accessToken);
        const refreshTokenHash = (0, tokens_1.hashToken)(refreshToken);
        await this.sessionRepo.save(this.sessionRepo.create({
            user,
            accessTokenHash,
            refreshTokenHash,
            expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
        }));
        return { accessToken, refreshToken };
    }
    async refresh(refreshToken) {
        const refreshTokenHash = (0, tokens_1.hashToken)(refreshToken);
        const session = await this.sessionRepo.findOne({ where: { refreshTokenHash }, relations: ['user'] });
        if (!session || session.revokedAt)
            return null;
        if (session.expiresAt && session.expiresAt.getTime() < Date.now())
            return null;
        const nextTokens = await this.issueSession(session.user);
        session.revokedAt = new Date();
        await this.sessionRepo.save(session);
        return { user: session.user, ...nextTokens };
    }
    async logout(refreshToken) {
        const refreshTokenHash = (0, tokens_1.hashToken)(refreshToken);
        const session = await this.sessionRepo.findOneBy({ refreshTokenHash });
        if (!session)
            return;
        session.revokedAt = new Date();
        await this.sessionRepo.save(session);
    }
    async validateAccessToken(accessToken) {
        const accessTokenHash = (0, tokens_1.hashToken)(accessToken);
        const session = await this.sessionRepo.findOne({ where: { accessTokenHash, revokedAt: (0, typeorm_1.IsNull)() }, relations: ['user'] });
        if (!session || !session.user?.active)
            return null;
        if (session.expiresAt && session.expiresAt.getTime() < Date.now())
            return null;
        return session.user;
    }
}
exports.AuthService = AuthService;
