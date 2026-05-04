"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLibsqlClient = createLibsqlClient;
const client_1 = require("@libsql/client");
function createLibsqlClient(url, authToken) {
    return (0, client_1.createClient)({
        url,
        authToken,
    });
}
