"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = projectRoutes;
const ProjectService_1 = require("../../../application/projects/ProjectService");
const data_source_1 = require("../../../infrastructure/db/data-source");
const User_1 = require("../../../domain/entities/User");
const guards_1 = require("../guards");
const AuditService_1 = require("../../../application/audit/AuditService");
const validations_1 = require("../../../types/validations");
const database_presenter_1 = require("../database-presenter");
function presentProject(project) {
    return {
        ...project,
        databases: Array.isArray(project?.databases) ? project.databases.map((database) => (0, database_presenter_1.presentDatabase)(database)) : project?.databases,
    };
}
async function projectRoutes(app) {
    const projectService = new ProjectService_1.ProjectService();
    const auditService = new AuditService_1.AuditService();
    app.get('/projects', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'projects.read')))
            return;
        const user = request.user;
        const projects = await projectService.listProjects(user?.sub);
        return reply.send({ projects: projects.map((project) => presentProject(project)) });
    });
    app.post('/projects', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'projects.write')))
            return;
        const body = (0, validations_1.parseAndValidate)(validations_1.createProjectSchema, request.body, 'create project');
        const userId = request.user?.sub;
        const userRepo = data_source_1.AppDataSource.getRepository(User_1.User);
        const owner = await userRepo.findOneBy({ id: userId });
        if (!owner)
            return reply.status(404).send({ error: 'owner not found' });
        const project = await projectService.createProject(owner, body.name);
        await auditService.record({ action: 'project.create', resourceType: 'project', resourceId: project.id, actorId: userId });
        return reply.status(201).send({ project: presentProject(project) });
    });
    app.get('/projects/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'projects.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureProjectAccess)(request, reply, id);
        if (!access)
            return;
        const project = await projectService.getProject(id);
        if (!project)
            return reply.status(404).send({ error: 'project not found' });
        return reply.send({ project: presentProject(project) });
    });
    app.delete('/projects/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'projects.write')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureProjectAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const result = await projectService.deleteProject(id);
            const userId = request.user?.sub;
            await auditService.record({ action: 'project.delete', resourceType: 'project', resourceId: id, actorId: userId });
            return reply.send(result);
        }
        catch (err) {
            return reply.status(404).send({ error: err.message });
        }
    });
}
