import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Project } from '../../domain/entities/Project';
import { User } from '../../domain/entities/User';
import { ProjectMember } from '../../domain/entities/ProjectMember';
import { Database } from '../../domain/entities/Database';
import { SqliteStorageService } from '../../infrastructure/storage/SqliteStorageService';

export class ProjectService {
  private projectRepo = AppDataSource.getRepository(Project);
  private memberRepo = AppDataSource.getRepository(ProjectMember);
  private databaseRepo = AppDataSource.getRepository(Database);

  async createProject(owner: User, name: string) {
    const project = await this.projectRepo.save(this.projectRepo.create({ name, owner }));
    await this.memberRepo.save(this.memberRepo.create({ project, user: owner }));
    return Object.assign(project, { databaseCount: 0 });
  }

  async listProjects(userId?: string) {
    const projects = userId
      ? await this.projectRepo
        .createQueryBuilder('project')
        .leftJoinAndSelect('project.owner', 'owner')
        .leftJoinAndSelect('project.members', 'members')
        .leftJoin('project.members', 'memberFilter')
        .leftJoin('memberFilter.user', 'memberUser')
        .where('owner.id = :userId OR memberUser.id = :userId', { userId })
        .getMany()
      : await this.projectRepo.find({ relations: ['owner', 'members'] });

    return this.attachDatabaseCounts(projects);
  }

  private async attachDatabaseCounts(projects: Project[]) {
    if (projects.length === 0) return projects;

    const rows = await this.databaseRepo
      .createQueryBuilder('database')
      .leftJoin('database.project', 'project')
      .select('project.id', 'projectId')
      .addSelect('COUNT(database.id)', 'count')
      .where('project.id IN (:...projectIds)', { projectIds: projects.map((project) => project.id) })
      .groupBy('project.id')
      .getRawMany<{ projectId: string; count: string | number }>();

    const counts = new Map(rows.map((row) => [row.projectId, Number(row.count) || 0]));
    return projects.map((project) => Object.assign(project, {
      databaseCount: counts.get(project.id) || 0,
    }));
  }

  async getProject(id: string) {
    return this.projectRepo.findOne({ where: { id }, relations: ['owner', 'members', 'members.user', 'databases'] });
  }

  async deleteProject(id: string) {
    const project = await this.projectRepo.findOneByOrFail({ id });
    await this.projectRepo.remove(project);

    const storageService = new SqliteStorageService();
    await fs.promises.rm(
      path.join(storageService.snapshotRootDirectory(), id),
      { recursive: true, force: true },
    ).catch(() => undefined);

    return { ok: true };
  }
}
