import { AppDataSource } from '../../infrastructure/db/data-source';
import { User } from '../../domain/entities/User';
import { Session } from '../../domain/entities/Session';
import { UserRole } from '../../domain/entities/UserRole';
import { Role } from '../../domain/entities/Role';
import { hashPassword, verifyPassword } from '../../infrastructure/security/password';
import { hashToken, randomToken } from '../../infrastructure/security/tokens';
import { IsNull } from 'typeorm';

export class AuthService {
  private userRepo = AppDataSource.getRepository(User);
  private sessionRepo = AppDataSource.getRepository(Session);
  private roleRepo = AppDataSource.getRepository(Role);
  private userRoleRepo = AppDataSource.getRepository(UserRole);

  async register(email: string, password: string) {
    const existing = await this.userRepo.findOneBy({ email });
    if (existing) throw new Error('Email already registered');

    const passwordHash = await hashPassword(password);
    const user = await this.userRepo.save(this.userRepo.create({ email, passwordHash, active: true }));

    const defaultRole = await this.roleRepo.findOneBy({ name: 'admin' });
    if (defaultRole) {
      await this.userRoleRepo.save(this.userRoleRepo.create({ user, role: defaultRole }));
    }

    return user;
  }

  async authenticate(email: string, password: string) {
    const user = await this.userRepo.findOneBy({ email });
    if (!user || !user.active) return null;
    return (await verifyPassword(user.passwordHash, password)) ? user : null;
  }

  async issueSession(user: User) {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessTokenHash = hashToken(accessToken);
    const refreshTokenHash = hashToken(refreshToken);

    await this.sessionRepo.save(this.sessionRepo.create({
      user,
      accessTokenHash,
      refreshTokenHash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    }));

    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string) {
    const refreshTokenHash = hashToken(refreshToken);
    const session = await this.sessionRepo.findOne({ where: { refreshTokenHash }, relations: ['user'] });
    if (!session || session.revokedAt) return null;
    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) return null;
    const nextTokens = await this.issueSession(session.user);
    session.revokedAt = new Date();
    await this.sessionRepo.save(session);
    return { user: session.user, ...nextTokens };
  }

  async logout(refreshToken: string) {
    const refreshTokenHash = hashToken(refreshToken);
    const session = await this.sessionRepo.findOneBy({ refreshTokenHash });
    if (!session) return;
    session.revokedAt = new Date();
    await this.sessionRepo.save(session);
  }

  async validateAccessToken(accessToken: string) {
    const accessTokenHash = hashToken(accessToken);
    const session = await this.sessionRepo.findOne({ where: { accessTokenHash, revokedAt: IsNull() }, relations: ['user'] });
    if (!session || (session.expiresAt && session.expiresAt.getTime() < Date.now())) return null;
    return session.user;
  }
}
