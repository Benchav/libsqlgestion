"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapLibsqlClient = wrapLibsqlClient;
function wrapLibsqlClient(core) {
    return {
        execute(sql, args) {
            return core.execute(sql, args ?? []);
        },
        batch(queries, mode) {
            return core.batch(queries, mode);
        },
        close() {
            core.close();
        },
    };
}
