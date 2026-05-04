"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteClient = void 0;
const sqlite3_1 = __importDefault(require("sqlite3"));
const util_1 = require("util");
class SqliteClient {
    constructor(filePath) {
        this.db = new sqlite3_1.default.Database(filePath);
        this.all = (0, util_1.promisify)(this.db.all.bind(this.db));
        this.get = (0, util_1.promisify)(this.db.get.bind(this.db));
        this.run = (sql, params = []) => new Promise((resolve, reject) => {
            this.db.run(sql, params, function (error) {
                if (error)
                    return reject(error);
                resolve({ changes: this.changes ?? 0, lastID: this.lastID ?? 0 });
            });
        });
    }
    close() {
        this.db.close();
    }
}
exports.SqliteClient = SqliteClient;
