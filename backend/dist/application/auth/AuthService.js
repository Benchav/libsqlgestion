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
        const passwordHash = await (0, password_1.hashPassword)(password);
        const user = await this.userRepo.save(this.userRepo.create({ email, passwordHash, active: true }));
        const defaultRole = await this.roleRepo.findOneBy({ name: 'admin' });
        if (defaultRole) {
            await this.userRoleRepo.save(this.userRoleRepo.create({ user, role: defaultRole }));
        }
        return user;
    }
    async authenticate(email, password) {
        const user = await this.userRepo.findOneBy({ email });
        if (!user || !user.active)
            return null;
        return (await (0, password_1.verifyPassword)(user.passwordHash, password)) ? user : null;
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
        if (!session || (session.expiresAt && session.expiresAt.getTime() < Date.now()))
            return null;
        return session.user;
    }
}
exports.AuthService = AuthService;
