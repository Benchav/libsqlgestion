"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encrypt = encrypt;
exports.decrypt = decrypt;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ALGO = 'aes-256-gcm';
const MASTER_KEY_FILE = process.env.MASTER_KEY_FILE || path_1.default.join(process.cwd(), 'data', 'master.key');
function loadMasterKey() {
    const envKey = process.env.MASTER_KEY;
    if (envKey) {
        return envKey;
    }
    fs_1.default.mkdirSync(path_1.default.dirname(MASTER_KEY_FILE), { recursive: true });
    if (!fs_1.default.existsSync(MASTER_KEY_FILE)) {
        fs_1.default.writeFileSync(MASTER_KEY_FILE, crypto_1.default.randomBytes(32).toString('hex'));
    }
    return fs_1.default.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
}
const key = Buffer.from(loadMasterKey(), 'hex');
function encrypt(plainText) {
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
}
function decrypt(data) {
    const b = Buffer.from(data, 'base64');
    const iv = b.slice(0, 12);
    const tag = b.slice(12, 28);
    const encrypted = b.slice(28);
    const decipher = crypto_1.default.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
}
