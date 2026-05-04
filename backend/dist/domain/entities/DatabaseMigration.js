"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseMigration = void 0;
const typeorm_1 = require("typeorm");
const Database_1 = require("./Database");
const User_1 = require("./User");
let DatabaseMigration = class DatabaseMigration {
};
exports.DatabaseMigration = DatabaseMigration;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], DatabaseMigration.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => Database_1.Database, { onDelete: 'CASCADE' }),
    __metadata("design:type", Database_1.Database)
], DatabaseMigration.prototype, "database", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], DatabaseMigration.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ unique: true }),
    __metadata("design:type", String)
], DatabaseMigration.prototype, "checksum", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'simple-json', nullable: true }),
    __metadata("design:type", Array)
], DatabaseMigration.prototype, "statements", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], DatabaseMigration.prototype, "source", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 'applied' }),
    __metadata("design:type", String)
], DatabaseMigration.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], DatabaseMigration.prototype, "errorMessage", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => User_1.User, { nullable: true, onDelete: 'SET NULL' }),
    __metadata("design:type", Object)
], DatabaseMigration.prototype, "actor", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], DatabaseMigration.prototype, "appliedAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], DatabaseMigration.prototype, "updatedAt", void 0);
exports.DatabaseMigration = DatabaseMigration = __decorate([
    (0, typeorm_1.Entity)('database_migrations')
], DatabaseMigration);
