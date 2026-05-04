"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.randomToken = randomToken;
exports.hashToken = hashToken;
const crypto_1 = __importDefault(require("crypto"));
function randomToken() {
    return crypto_1.default.randomBytes(32).toString('hex');
}
function hashToken(token) {
    return crypto_1.default.createHash('sha256').update(token).digest('hex');
}
