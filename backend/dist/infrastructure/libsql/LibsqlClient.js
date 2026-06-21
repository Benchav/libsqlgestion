"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLibsqlClient = createLibsqlClient;
const client_1 = require("@libsql/client");
const libsql_client_1 = require("../../types/libsql-client");
function createLibsqlClient(url, authToken) {
    return (0, libsql_client_1.wrapLibsqlClient)((0, client_1.createClient)({ url, authToken }));
}
