"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProvisioningService = void 0;
const DatabaseService_1 = require("../databases/DatabaseService");
class ProvisioningService {
    constructor() {
        this.databaseService = new DatabaseService_1.DatabaseService();
    }
    async provisionSqlite(projectId, name, subdomain) {
        return this.databaseService.createDatabase(projectId, {
            name,
            type: 'sqlite',
            subdomain,
            metadata: { provisioned: true },
        });
    }
    async provisionLibsql(projectId, input) {
        return this.databaseService.createDatabase(projectId, {
            name: input.name,
            type: 'libsql',
            url: input.url,
            token: input.token,
            subdomain: input.subdomain,
            metadata: { provisioned: true },
        });
    }
}
exports.ProvisioningService = ProvisioningService;
