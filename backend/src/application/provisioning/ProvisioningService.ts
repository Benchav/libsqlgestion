import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../databases/DatabaseService';

export class ProvisioningService {
  private databaseService = new DatabaseService();

  async provisionSqlite(projectId: string, name: string, subdomain?: string) {
    return this.databaseService.createDatabase(projectId, {
      name,
      type: 'sqlite',
      subdomain,
      metadata: { provisioned: true },
    });
  }

  async provisionLibsql(projectId: string, input: { name: string; url: string; token: string; subdomain?: string }) {
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
