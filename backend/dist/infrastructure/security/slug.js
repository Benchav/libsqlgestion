"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugify = slugify;
exports.ensureSubdomain = ensureSubdomain;
function slugify(value) {
    return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 48);
}
function ensureSubdomain(baseName, uniqueSuffix) {
    const slug = slugify(baseName) || 'db';
    return `${slug}-${uniqueSuffix.slice(0, 8)}`;
}
