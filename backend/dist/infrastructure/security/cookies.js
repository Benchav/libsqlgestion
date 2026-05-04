"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCookies = parseCookies;
exports.sessionCookie = sessionCookie;
exports.clearSessionCookie = clearSessionCookie;
const COOKIE_BASE = ['Path=/api/v1', 'HttpOnly', 'SameSite=Lax'];
function parseCookies(headerValue) {
    const cookies = {};
    if (!headerValue)
        return cookies;
    for (const chunk of headerValue.split(';')) {
        const index = chunk.indexOf('=');
        if (index === -1)
            continue;
        const key = chunk.slice(0, index).trim();
        const value = chunk.slice(index + 1).trim();
        if (key)
            cookies[key] = decodeURIComponent(value);
    }
    return cookies;
}
function sessionCookie(name, value, maxAgeSeconds) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${maxAgeSeconds}`, ...COOKIE_BASE];
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
        parts.push('Secure');
    }
    return parts.join('; ');
}
function clearSessionCookie(name) {
    const parts = [`${name}=`, 'Max-Age=0', ...COOKIE_BASE];
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
        parts.push('Secure');
    }
    return parts.join('; ');
}
