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
exports.DatabaseSnapshotPolicy = void 0;
const typeorm_1 = require("typeorm");
let DatabaseSnapshotPolicy = class DatabaseSnapshotPolicy {
};
exports.DatabaseSnapshotPolicy = DatabaseSnapshotPolicy;
__decorate([
    (0, typeorm_1.PrimaryColumn)(),
    __metadata("design:type", String)
], DatabaseSnapshotPolicy.prototype, "databaseId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer', default: 60 }),
    __metadata("design:type", Number)
], DatabaseSnapshotPolicy.prototype, "restorePointIntervalMinutes", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], DatabaseSnapshotPolicy.prototype, "dailyEnabled", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer', default: 2 }),
    __metadata("design:type", Number)
], DatabaseSnapshotPolicy.prototype, "dailyAtHour", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer', default: 14 }),
    __metadata("design:type", Number)
], DatabaseSnapshotPolicy.prototype, "dailyRetention", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], DatabaseSnapshotPolicy.prototype, "weeklyEnabled", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer', default: 0 }),
    __metadata("design:type", Number)
], DatabaseSnapshotPolicy.prototype, "weeklyDayOfWeek", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer', default: 2 }),
    __metadata("design:type", Number)
], DatabaseSnapshotPolicy.prototype, "weeklyAtHour", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer', default: 8 }),
    __metadata("design:type", Number)
], DatabaseSnapshotPolicy.prototype, "weeklyRetention", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], DatabaseSnapshotPolicy.prototype, "monthlyEnabled", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer', default: 1 }),
    __metadata("design:type", Number)
], DatabaseSnapshotPolicy.prototype, "monthlyDayOfMonth", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer', default: 2 }),
    __metadata("design:type", Number)
], DatabaseSnapshotPolicy.prototype, "monthlyAtHour", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer', default: 12 }),
    __metadata("design:type", Number)
], DatabaseSnapshotPolicy.prototype, "monthlyRetention", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 'UTC' }),
    __metadata("design:type", String)
], DatabaseSnapshotPolicy.prototype, "timezone", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], DatabaseSnapshotPolicy.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], DatabaseSnapshotPolicy.prototype, "updatedAt", void 0);
exports.DatabaseSnapshotPolicy = DatabaseSnapshotPolicy = __decorate([
    (0, typeorm_1.Entity)('database_snapshot_policies')
], DatabaseSnapshotPolicy);
