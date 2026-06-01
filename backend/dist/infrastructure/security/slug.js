"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugify = slugify;
exports.ensureSubdomain = ensureSubdomain;
exports.normalizeSubdomain = normalizeSubdomain;
exports.isValidSubdomainLabel = isValidSubdomainLabel;
exports.assertValidSubdomainLabel = assertValidSubdomainLabel;
exports.normalizeDomain = normalizeDomain;
exports.assertValidDomain = assertValidDomain;
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
const SUBDOMAIN_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_REGEX = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
function ensureSubdomain(baseName, uniqueSuffix) {
    const slug = slugify(baseName) || 'db';
    return `${slug}-${uniqueSuffix.slice(0, 8)}`;
}
function normalizeSubdomain(value) {
    return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
}
function isValidSubdomainLabel(value) {
    return SUBDOMAIN_LABEL_REGEX.test(value);
}
function assertValidSubdomainLabel(value, fieldName = 'subdomain') {
    const normalized = normalizeSubdomain(value);
    if (!normalized || !isValidSubdomainLabel(normalized)) {
        throw new Error(`${fieldName} must be a valid DNS label`);
    }
    return normalized;
}
function normalizeDomain(value) {
    return value.trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
}
function assertValidDomain(value, fieldName = 'domain') {
    const normalized = normalizeDomain(value);
    if (!normalized || !DOMAIN_REGEX.test(normalized)) {
        throw new Error(`${fieldName} must be a valid domain name`);
    }
    return normalized;
}
