"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppDataSource = void 0;
const typeorm_1 = require("typeorm");
const User_1 = require("../../domain/entities/User");
const Project_1 = require("../../domain/entities/Project");
const Database_1 = require("../../domain/entities/Database");
const Role_1 = require("../../domain/entities/Role");
const Permission_1 = require("../../domain/entities/Permission");
const UserRole_1 = require("../../domain/entities/UserRole");
const AuditLog_1 = require("../../domain/entities/AuditLog");
const Session_1 = require("../../domain/entities/Session");
const ProjectMember_1 = require("../../domain/entities/ProjectMember");
const databaseFile = process.env.DATABASE_FILE || './data/control.db';
exports.AppDataSource = new typeorm_1.DataSource({
    type: 'sqlite',
    database: databaseFile,
    synchronize: true,
    logging: false,
    entities: [User_1.User, Project_1.Project, Database_1.Database, Role_1.Role, Permission_1.Permission, UserRole_1.UserRole, AuditLog_1.AuditLog, Session_1.Session, ProjectMember_1.ProjectMember],
});
