import { AppDataSource } from '../../infrastructure/db/data-source';
import { Project } from '../../domain/entities/Project';
import { User } from '../../domain/entities/User';
import { ProjectMember } from '../../domain/entities/ProjectMember';

export class ProjectService {
  private projectRepo = AppDataSource.getRepository(Project);
  private memberRepo = AppDataSource.getRepository(ProjectMember);

  async createProject(owner: User, name: string) {
    const project = await this.projectRepo.save(this.projectRepo.create({ name, owner }));
    await this.memberRepo.save(this.memberRepo.create({ project, user: owner }));
    return project;
  }

  async listProjects(userId?: string) {
    if (!userId) return this.projectRepo.find({ relations: ['owner', 'members'] });
    return this.projectRepo
      .createQueryBuilder('project')
      .leftJoinAndSelect('project.owner', 'owner')
      .leftJoinAndSelect('project.members', 'members')
      .leftJoin('project.members', 'memberFilter')
      .leftJoin('memberFilter.user', 'memberUser')
      .where('owner.id = :userId OR memberUser.id = :userId', { userId })
      .getMany();
  }

  async getProject(id: string) {
    return this.projectRepo.findOne({ where: { id }, relations: ['owner', 'members', 'members.user', 'databases'] });
  }

  async deleteProject(id: string) {
    const project = await this.projectRepo.findOneByOrFail({ id });
    await this.projectRepo.remove(project);
    return { ok: true };
  }
}
