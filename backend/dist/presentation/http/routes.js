"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = routes;
const AuthController_1 = __importDefault(require("./controllers/AuthController"));
const ProjectController_1 = __importDefault(require("./controllers/ProjectController"));
const DatabaseController_1 = __importDefault(require("./controllers/DatabaseController"));
const AuditController_1 = __importDefault(require("./controllers/AuditController"));
const UserController_1 = __importDefault(require("./controllers/UserController"));
const SchemaController_1 = __importDefault(require("./controllers/SchemaController"));
const QueryController_1 = __importDefault(require("./controllers/QueryController"));
const ProvisioningController_1 = __importDefault(require("./controllers/ProvisioningController"));
const HealthController_1 = __importDefault(require("./controllers/HealthController"));
async function routes(app) {
    app.register(HealthController_1.default);
    app.register(AuthController_1.default);
    app.register(ProjectController_1.default);
    app.register(DatabaseController_1.default);
    app.register(AuditController_1.default);
    app.register(UserController_1.default);
    app.register(SchemaController_1.default);
    app.register(QueryController_1.default);
    app.register(ProvisioningController_1.default);
}
