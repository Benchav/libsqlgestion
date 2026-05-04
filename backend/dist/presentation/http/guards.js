"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensurePermission = ensurePermission;
exports.ensureProjectAccess = ensureProjectAccess;
exports.ensureDatabaseAccess = ensureDatabaseAccess;
const authorization_1 = require("../../application/auth/authorization");
const data_source_1 = require("../../infrastructure/db/data-source");
const Project_1 = require("../../domain/entities/Project");
const Database_1 = require("../../domain/entities/Database");
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
async function ensureProjectAccess(request, reply, projectId) {
    const user = request.user;
    if (!user?.sub) {
        reply.code(401).send({ error: 'unauthorized' });
        return null;
    }
    const project = await data_source_1.AppDataSource.getRepository(Project_1.Project).findOne({
        where: { id: projectId },
        relations: ['owner', 'members', 'members.user'],
    });
    if (!project) {
        reply.code(404).send({ error: 'project not found' });
        return null;
    }
    const isOwner = project.owner?.id === user.sub;
    const isMember = project.members?.some((member) => member.user?.id === user.sub);
    if (!isOwner && !isMember) {
        reply.code(403).send({ error: 'forbidden' });
        return null;
    }
    return project;
}
async function ensureDatabaseAccess(request, reply, databaseId) {
    const user = request.user;
    if (!user?.sub) {
        reply.code(401).send({ error: 'unauthorized' });
        return null;
    }
    const database = await data_source_1.AppDataSource.getRepository(Database_1.Database).findOne({
        where: { id: databaseId },
        relations: ['project', 'project.owner', 'project.members', 'project.members.user'],
    });
    if (!database) {
        reply.code(404).send({ error: 'database not found' });
        return null;
    }
    const project = database.project;
    const isOwner = project?.owner?.id === user.sub;
    const isMember = project?.members?.some((member) => member.user?.id === user.sub);
    if (!isOwner && !isMember) {
        reply.code(403).send({ error: 'forbidden' });
        return null;
    }
    return database;
}
