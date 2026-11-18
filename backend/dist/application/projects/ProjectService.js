"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const data_source_1 = require("../../infrastructure/db/data-source");
const Project_1 = require("../../domain/entities/Project");
const ProjectMember_1 = require("../../domain/entities/ProjectMember");
const SqliteStorageService_1 = require("../../infrastructure/storage/SqliteStorageService");
class ProjectService {
    constructor() {
        this.projectRepo = data_source_1.AppDataSource.getRepository(Project_1.Project);
        this.memberRepo = data_source_1.AppDataSource.getRepository(ProjectMember_1.ProjectMember);
    }
    async createProject(owner, name) {
        const project = await this.projectRepo.save(this.projectRepo.create({ name, owner }));
        await this.memberRepo.save(this.memberRepo.create({ project, user: owner }));
        return project;
    }
    async listProjects(userId) {
        if (!userId)
            return this.projectRepo.find({ relations: ['owner', 'members'] });
        return this.projectRepo
            .createQueryBuilder('project')
            .leftJoinAndSelect('project.owner', 'owner')
            .leftJoinAndSelect('project.members', 'members')
            .leftJoin('project.members', 'memberFilter')
            .leftJoin('memberFilter.user', 'memberUser')
            .where('owner.id = :userId OR memberUser.id = :userId', { userId })
            .getMany();
    }
    async getProject(id) {
        return this.projectRepo.findOne({ where: { id }, relations: ['owner', 'members', 'members.user', 'databases'] });
    }
    async deleteProject(id) {
        const project = await this.projectRepo.findOneByOrFail({ id });
        await this.projectRepo.remove(project);
        const storageService = new SqliteStorageService_1.SqliteStorageService();
        await fs_1.default.promises.rm(path_1.default.join(storageService.snapshotRootDirectory(), id), { recursive: true, force: true }).catch(() => undefined);
        return { ok: true };
    }
}
exports.ProjectService = ProjectService;
