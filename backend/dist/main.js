"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const data_source_1 = require("./infrastructure/db/data-source");
const server_1 = require("./server");
const auth_bootstrap_1 = require("./application/auth/auth.bootstrap");
const start = async () => {
    await data_source_1.AppDataSource.initialize();
    await data_source_1.AppDataSource.runMigrations();
    await (0, auth_bootstrap_1.bootstrapSecurityCatalog)();
    const app = (0, server_1.buildServer)();
    try {
        await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
        console.log('Server started on port', process.env.PORT || 3000);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};
start();
