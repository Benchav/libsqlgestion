import { AppDataSource } from '../../infrastructure/db/data-source';
import { User } from '../../domain/entities/User';
import argon2 from 'argon2';

export class AuthService {
  private repo = AppDataSource.getRepository(User);

  async register(email: string, password: string) {
    const existing = await this.repo.findOneBy({ email });
    if (existing) throw new Error('Email already registered');
    const passwordHash = await argon2.hash(password);
    const user = this.repo.create({ email, passwordHash });
    return await this.repo.save(user);
  }

  async validateUser(email: string, password: string) {
    const user = await this.repo.findOneBy({ email });
    if (!user) return null;
    if (await argon2.verify(user.passwordHash, password)) return user;
    return null;
  }
}
