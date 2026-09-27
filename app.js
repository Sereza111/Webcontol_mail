require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const dns = require('dns').promises;

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

// Beget API credentials
const BEGET_LOGIN = process.env.BEGET_LOGIN;
const BEGET_PASSWORD = process.env.BEGET_PASSWORD;
const BEGET_API_BASE = 'https://api.beget.com/api';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite database (SQLITE_PATH for Docker volume, default cwd)
const db = new Database(process.env.SQLITE_PATH || 'mailboxes.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS mailboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        domain TEXT NOT NULL,
        mailbox_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity_at DATETIME
    )
`);

function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(item => item.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

ensureColumn('mailboxes', 'last_activity_at', 'DATETIME');
db.exec(`
    CREATE TABLE IF NOT EXISTS domain_meta (
        domain TEXT PRIMARY KEY,
        expires_at TEXT,
        nameservers TEXT NOT NULL DEFAULT '[]',
        mx_records TEXT NOT NULL DEFAULT '[]',
        remote_mailbox_count INTEGER,
        checked_at DATETIME,
        remote_checked_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS invitations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'user',
        label TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME,
        revoked_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS generator_sessions (
        token_hash TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL
    );
`);
db.prepare(`UPDATE mailboxes SET last_activity_at = created_at
    WHERE last_activity_at IS NULL AND created_at IS NOT NULL`).run();

const SESSION_COOKIE = 'generator_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_SYNC_TOKEN = process.env.GENERATOR_ACTIVITY_TOKEN || '';
const AUTH_ENABLED = process.env.GENERATOR_AUTH_ENABLED !== 'false';
const failedLogins = new Map();

function hashSecret(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function secretsEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seedInvitations() {
    const insert = db.prepare('INSERT OR IGNORE INTO invitations (code_hash, role, label) VALUES (?, ?, ?)');
    const seeds = [];
    if (process.env.GENERATOR_ADMIN_INVITE) {
        seeds.push([process.env.GENERATOR_ADMIN_INVITE, 'admin', 'Администратор']);
    }
    for (const code of String(process.env.GENERATOR_INVITES || '').split(',')) {
        const value = code.trim();
        if (value) seeds.push([value, 'user', 'Приглашение']);
    }
    for (const [code, role, label] of seeds) insert.run(hashSecret(code), role, label);
}

seedInvitations();

function readSession(req) {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    if (!match) return null;
    const tokenHash = hashSecret(decodeURIComponent(match[1]));
    const session = db.prepare(`SELECT role FROM generator_sessions
        WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP`).get(tokenHash);
    return session || null;
}

function requireAuth(req, res, next) {
    if (!AUTH_ENABLED) {
        req.auth = { role: 'admin' };
        return next();
    }
    const session = readSession(req);
    if (!session) return res.status(401).json({ error: 'Требуется приглашение' });
    req.auth = session;
    next();
}

function requireAdmin(req, res, next) {
    if (!req.auth || req.auth.role !== 'admin') {
        return res.status(403).json({ error: 'Нужны права администратора' });
    }
    next();
}

// Rate limiter for Beget API (max 60 requests per minute)
let requestQueue = [];
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1100; // ~55 requests per minute to be safe

async function rateLimitedRequest(requestFn) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }
    
    lastRequestTime = Date.now();
    return requestFn();
}

// Generate random mailbox name (5-12 lowercase letters/numbers)
function generateMailboxName() {
    const length = crypto.randomInt(5, 13);
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    result += chars.charAt(crypto.randomInt(26));
    for (let i = 1; i < length; i++) {
        result += chars.charAt(crypto.randomInt(chars.length));
    }
    return result;
}

// Generate random password (12+ characters with letters, numbers, and symbols)
function generatePassword() {
    const length = crypto.randomInt(14, 19);
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const symbols = '!@#$%^&*()_+-=[]{}';
    const allChars = lowercase + uppercase + numbers + symbols;
    
    // Ensure at least one of each type
    let password = '';
    password += lowercase.charAt(crypto.randomInt(lowercase.length));
    password += uppercase.charAt(crypto.randomInt(uppercase.length));
    password += numbers.charAt(crypto.randomInt(numbers.length));
    password += symbols.charAt(crypto.randomInt(symbols.length));
    
    // Fill the rest
    for (let i = 4; i < length; i++) {
        password += allChars.charAt(crypto.randomInt(allChars.length));
    }
    
    const characters = password.split('');
    for (let i = characters.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [characters[i], characters[j]] = [characters[j], characters[i]];
    }
    return characters.join('');
}

function validDomain(domain) {
    return typeof domain === 'string' && domain.length <= 253 &&
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(domain);
}

function begetSucceeded(result) {
    return result?.status === 'success' &&
        (!result.answer?.status || result.answer.status === 'success');
}

// Beget API call helper
async function begetApiCall(method, params = {}) {
    const url = `${BEGET_API_BASE}/${method}`;
    
    // Manually build query string to ensure proper encoding
    const queryParts = [
        `login=${encodeURIComponent(BEGET_LOGIN)}`,
        `passwd=${encodeURIComponent(BEGET_PASSWORD)}`,
        `input_format=json`,
        `output_format=json`,
        `input_data=${encodeURIComponent(JSON.stringify(params))}`
    ];
    const queryString = queryParts.join('&');
    
    const fullUrl = `${url}?${queryString}`;
    console.log(`API Call: ${method}`);
    
    try {
        const response = await axios.get(fullUrl);
        console.log(`API Response (${method}):`, JSON.stringify(response.data).substring(0, 200));
        return response.data;
    } catch (error) {
        console.error(`API Error (${method}):`, error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
        throw error;
    }
}

function extractBegetError(result, fallback = 'Beget API request failed') {
    if (!result || typeof result !== 'object') {
        return fallback;
    }

    const knownError =
        result.answer?.error ||
        result.answer?.message ||
        result.error ||
        result.message;

    if (knownError) {
        return String(knownError);
    }

    if (result.answer?.status && result.answer.status !== 'success') {
        return `Beget API status: ${result.answer.status}`;
    }

    if (result.status && result.status !== 'success') {
        return `Beget request status: ${result.status}`;
    }

    return fallback;
}

function normalizeMailboxName(mailbox, domain) {
    let value;

    if (typeof mailbox === 'string') {
        value = mailbox;
    } else if (mailbox && typeof mailbox === 'object') {
        value = mailbox.mailbox || mailbox.mailbox_name || mailbox.email ||
            mailbox.address || mailbox.login || mailbox.name;
    }

    if (typeof value !== 'string') {
        return null;
    }

    value = value.trim();
    if (!value) {
        return null;
    }

    const atIndex = value.lastIndexOf('@');
    if (atIndex !== -1) {
        const mailboxDomain = value.slice(atIndex + 1);
        if (mailboxDomain.toLowerCase() !== domain.toLowerCase()) {
            return null;
        }
        value = value.slice(0, atIndex);
    }

    return value || null;
}

function getBegetMailboxNames(result, domain) {
    const rawMailboxes = result?.answer?.result;
    if (!Array.isArray(rawMailboxes)) {
        throw new Error('Beget returned an unexpected mailbox list format');
    }

    const uniqueNames = new Map();

    for (const mailbox of rawMailboxes) {
        const name = normalizeMailboxName(mailbox, domain);
        if (name && !uniqueNames.has(name.toLowerCase())) {
            uniqueNames.set(name.toLowerCase(), name);
        }
    }

    const mailboxNames = [...uniqueNames.values()];
    if (rawMailboxes.length > 0 && mailboxNames.length === 0) {
        throw new Error('Beget returned mailboxes in an unsupported format');
    }

    return mailboxNames;
}

async function fetchBegetDomains() {
    const result = await rateLimitedRequest(() => begetApiCall('domain/getList'));
    const requestOk = result?.status === 'success';
    const apiOk = !result?.answer?.status || result.answer.status === 'success';
    if (!requestOk || !apiOk) {
        const error = new Error(extractBegetError(result, 'Failed to get domains'));
        error.statusCode = 502;
        throw error;
    }
    return (Array.isArray(result?.answer?.result) ? result.answer.result : [])
        .filter(item => validDomain(item.fqdn))
        .map(item => ({ id: item.id, fqdn: item.fqdn.toLowerCase() }));
}

async function dropMailboxFromBeget(domain, mailbox) {
    const result = await rateLimitedRequest(() => begetApiCall('mail/dropMailbox', { domain, mailbox }));
    if (!begetSucceeded(result)) throw new Error(extractBegetError(result, 'Не удалось удалить ящик'));
    return result;
}

function readStoredDomainMeta(domain) {
    const row = db.prepare('SELECT * FROM domain_meta WHERE domain = ?').get(domain);
    if (!row) return null;
    return {
        ...row,
        nameservers: JSON.parse(row.nameservers || '[]'),
        mxRecords: JSON.parse(row.mx_records || '[]')
    };
}

function domainStatus(meta) {
    if (!meta.expiresAt) return { expiryState: 'unknown', daysRemaining: null };
    const daysRemaining = Math.ceil((new Date(meta.expiresAt).getTime() - Date.now()) / 86400000);
    return {
        expiryState: daysRemaining < 0 ? 'expired' : daysRemaining <= 30 ? 'warning' : 'active',
        daysRemaining
    };
}

async function queryRdapExpiry(domain) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
        const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { signal: controller.signal });
        if (!response.ok) return null;
        const payload = await response.json();
        const event = (payload.events || []).find(item => ['expiration', 'expiry'].includes(item.eventAction));
        return event?.eventDate || null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function inspectDomain(domain, force = false) {
    const stored = readStoredDomainMeta(domain);
    const checkedAt = stored?.checked_at ? new Date(stored.checked_at).getTime() : 0;
    if (!force && stored && Number.isFinite(checkedAt) && Date.now() - checkedAt < 6 * 60 * 60 * 1000) {
        return { domain, expiresAt: stored.expires_at, nameservers: stored.nameservers, mxRecords: stored.mxRecords, ...domainStatus({ expiresAt: stored.expires_at }) };
    }

    const [nameservers, mxRecords, expiresAt] = await Promise.all([
        dns.resolveNs(domain).catch(() => []),
        dns.resolveMx(domain).then(records => records.sort((a, b) => a.priority - b.priority).map(record => ({ exchange: record.exchange, priority: record.priority }))).catch(() => []),
        queryRdapExpiry(domain)
    ]);
    db.prepare(`INSERT INTO domain_meta (domain, expires_at, nameservers, mx_records, checked_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(domain) DO UPDATE SET expires_at = excluded.expires_at,
            nameservers = excluded.nameservers, mx_records = excluded.mx_records,
            checked_at = CURRENT_TIMESTAMP`).run(domain, expiresAt, JSON.stringify(nameservers), JSON.stringify(mxRecords));
    return { domain, expiresAt, nameservers, mxRecords, ...domainStatus({ expiresAt }) };
}

async function getDomainHealth(force = false) {
    const domains = await fetchBegetDomains();
    const result = [];
    for (const domain of domains) {
        const status = await inspectDomain(domain.fqdn, force);
        let remoteNames = [];
        let remoteError = null;
        try {
            remoteNames = await fetchBegetMailboxNames(domain.fqdn);
            db.prepare('UPDATE domain_meta SET remote_mailbox_count = ?, remote_checked_at = CURRENT_TIMESTAMP WHERE domain = ?')
                .run(remoteNames.length, domain.fqdn);
        } catch (error) {
            remoteError = error.message;
        }
        const local = db.prepare(`SELECT COUNT(*) AS total,
            SUM(CASE WHEN last_activity_at IS NOT NULL AND last_activity_at < datetime('now', '-30 days') THEN 1 ELSE 0 END) AS inactive
            FROM mailboxes WHERE domain = ?`).get(domain.fqdn);
        const cloudflare = status.nameservers.some(name => /\.ns\.cloudflare\.com\.?$/i.test(name));
        result.push({
            ...domain,
            ...status,
            dnsProvider: cloudflare ? 'Cloudflare' : 'Другой DNS-провайдер',
            cloudflare,
            mailboxCount: remoteNames.length || 0,
            localMailboxCount: local.total || 0,
            inactiveCount: local.inactive || 0,
            remoteError
        });
    }
    return result;
}

async function fetchBegetMailboxNames(domain) {
    const result = await rateLimitedRequest(() => begetApiCall('mail/getMailboxList', { domain }));
    const requestOk = result?.status === 'success';
    const apiOk = !result?.answer?.status || result.answer.status === 'success';

    if (!requestOk || !apiOk) {
        const error = new Error(extractBegetError(result, 'Failed to get mailboxes'));
        error.statusCode = 502;
        throw error;
    }

    try {
        return getBegetMailboxNames(result, domain);
    } catch (error) {
        error.statusCode = 502;
        throw error;
    }
}

app.use('/api', (req, res, next) => {
    if (req.path === '/auth/status' || req.path === '/auth/login') return next();
    if (req.path === '/mailbox-activity' && ACTIVITY_SYNC_TOKEN &&
        secretsEqual(req.get('x-activity-token') || '', ACTIVITY_SYNC_TOKEN)) return next();
    return requireAuth(req, res, next);
});

app.get('/api/auth/status', (req, res) => {
    const session = readSession(req);
    res.json({
        enabled: AUTH_ENABLED,
        authenticated: Boolean(session) || !AUTH_ENABLED,
        role: session?.role || (AUTH_ENABLED ? null : 'admin')
    });
});

app.post('/api/auth/login', (req, res) => {
    if (!AUTH_ENABLED) return res.json({ success: true, role: 'admin' });
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempts = (failedLogins.get(ip) || []).filter(timestamp => now - timestamp < 10 * 60 * 1000);
    if (attempts.length >= 10) {
        return res.status(429).json({ error: 'Слишком много попыток. Повторите позже.' });
    }

    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!code || code.length > 256) {
        return res.status(400).json({ error: 'Введите код приглашения' });
    }
    const invitation = db.prepare(`SELECT id, role FROM invitations
        WHERE code_hash = ? AND revoked_at IS NULL`).get(hashSecret(code));
    if (!invitation) {
        failedLogins.set(ip, [...attempts, now]);
        return res.status(401).json({ error: 'Код приглашения недействителен' });
    }

    failedLogins.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSecret(token);
    const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    db.prepare(`INSERT INTO generator_sessions (token_hash, role, expires_at) VALUES (?, ?, ?)`)
        .run(tokenHash, invitation.role, expiresAt);
    db.prepare('UPDATE invitations SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(invitation.id);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Lax; Secure`);
    res.json({ success: true, role: invitation.role });
});

app.post('/api/auth/logout', (req, res) => {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    if (match) db.prepare('DELETE FROM generator_sessions WHERE token_hash = ?')
        .run(hashSecret(decodeURIComponent(match[1])));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
    res.json({ success: true });
});

app.get('/api/admin/invitations', requireAdmin, (req, res) => {
    const invitations = db.prepare(`SELECT id, role, label, created_at, last_used_at, revoked_at
        FROM invitations ORDER BY created_at DESC`).all();
    res.json({ invitations });
});

app.post('/api/admin/invitations', requireAdmin, (req, res) => {
    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 80) : '';
    const code = crypto.randomBytes(18).toString('base64url');
    const result = db.prepare('INSERT INTO invitations (code_hash, role, label) VALUES (?, ?, ?)')
        .run(hashSecret(code), role, label);
    res.status(201).json({ id: result.lastInsertRowid, code, role, label });
});

app.delete('/api/admin/invitations/:id', requireAdmin, (req, res) => {
    const result = db.prepare('UPDATE invitations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(Number(req.params.id));
    if (!result.changes) return res.status(404).json({ error: 'Приглашение не найдено' });
    res.json({ success: true });
});

app.post('/api/mailbox-activity', (req, res) => {
    if (!ACTIVITY_SYNC_TOKEN || !secretsEqual(req.get('x-activity-token') || '', ACTIVITY_SYNC_TOKEN)) {
        return res.status(401).json({ error: 'Недействительный токен активности' });
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Некорректный ящик' });
    db.prepare(`UPDATE mailboxes SET last_activity_at = CURRENT_TIMESTAMP WHERE lower(email) = ?`).run(email);
    res.json({ success: true });
});

// API Routes

// Get list of domains
app.get('/api/domains', async (req, res) => {
    try {
        res.json({ success: true, domains: await fetchBegetDomains() });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
});

app.get('/api/domain-health', async (req, res) => {
    try {
        res.json({ success: true, domains: await getDomainHealth(req.query.refresh === '1') });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
});

app.post('/api/domain-health/refresh', async (req, res) => {
    try {
        const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim().toLowerCase() : '';
        if (!validDomain(domain)) return res.status(400).json({ success: false, error: 'Введите корректный домен' });
        res.json({ success: true, domain: await inspectDomain(domain, true) });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
});

// Attach a domain registered elsewhere to the Beget account. DNS stays at its registrar.
app.post('/api/domains', async (req, res) => {
    const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim().toLowerCase() : '';
    if (!validDomain(domain)) {
        return res.status(400).json({ success: false, error: 'Введите корректный домен' });
    }

    try {
        const current = await rateLimitedRequest(() => begetApiCall('domain/getList'));
        if (!begetSucceeded(current)) {
            return res.status(502).json({ success: false, error: extractBegetError(current) });
        }
        if (current.answer?.result?.some(item => item.fqdn?.toLowerCase() === domain)) {
            return res.json({ success: true, domain, alreadyExists: true, dns: await inspectDomain(domain, true) });
        }

        const zones = await rateLimitedRequest(() => begetApiCall('domain/getZoneList'));
        if (!begetSucceeded(zones)) {
            return res.status(502).json({ success: false, error: extractBegetError(zones) });
        }
        const zone = Object.entries(zones.answer?.result || {})
            .filter(([name]) => domain.endsWith(`.${name}`))
            .sort((a, b) => b[0].length - a[0].length)[0];
        if (!zone) {
            return res.status(400).json({ success: false, error: 'Зона домена не поддерживается Beget' });
        }
        const hostname = domain.slice(0, -zone[0].length - 1);
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
            return res.status(400).json({ success: false, error: 'Укажите основной домен без поддомена' });
        }

        const added = await rateLimitedRequest(() => begetApiCall('domain/addVirtual', {
            hostname,
            zone_id: zone[1].id
        }));
        if (!begetSucceeded(added)) {
            return res.status(502).json({ success: false, error: extractBegetError(added) });
        }
        res.status(201).json({ success: true, domain, id: added.answer?.result, dns: await inspectDomain(domain, true) });
    } catch (error) {
        res.status(502).json({ success: false, error: error.message });
    }
});

// Get mailbox list for a domain
app.get('/api/mailboxes/:domain', async (req, res) => {
    try {
        const { domain } = req.params;
        const mailboxes = await fetchBegetMailboxNames(domain);
        res.json({ success: true, mailboxes });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
});

// Synchronize the local list with mailboxes that currently exist on Beget.
// Beget does not return existing mailbox passwords, so imported rows have an
// empty password. Passwords generated by this application are kept intact.
app.post('/api/mailboxes/sync', async (req, res) => {
    try {
        const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : '';
        if (!domain) {
            return res.status(400).json({ success: false, error: 'Domain is required' });
        }

        const remoteNames = await fetchBegetMailboxNames(domain);
        const remoteByEmail = new Map(remoteNames.map(name => [
            `${name}@${domain}`.toLowerCase(),
            name
        ]));

        const synchronize = db.transaction(() => {
            const localRows = db.prepare('SELECT email FROM mailboxes WHERE domain = ?').all(domain);
            const deleteRow = db.prepare('DELETE FROM mailboxes WHERE email = ?');
            let removed = 0;

            for (const row of localRows) {
                if (!remoteByEmail.has(row.email.toLowerCase())) {
                    removed += deleteRow.run(row.email).changes;
                }
            }

            const insertRow = db.prepare(`
                INSERT OR IGNORE INTO mailboxes
                    (email, password, domain, mailbox_name, created_at)
                VALUES (?, '', ?, ?, NULL)
            `);
            let imported = 0;

            for (const [email, mailboxName] of remoteByEmail) {
                imported += insertRow.run(email, domain, mailboxName).changes;
            }

            return { imported, removed };
        });

        const changes = synchronize();
        const mailboxes = db.prepare(
            'SELECT * FROM mailboxes WHERE domain = ? ORDER BY created_at DESC, email ASC'
        ).all(domain);

        res.json({
            success: true,
            domain,
            mailboxes,
            total: mailboxes.length,
            imported: changes.imported,
            removed: changes.removed
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
});

// Get all locally stored mailboxes
app.get('/api/local-mailboxes', (req, res) => {
    try {
        const { domain } = req.query;
        let stmt;
        if (domain) {
            stmt = db.prepare('SELECT * FROM mailboxes WHERE domain = ? ORDER BY created_at DESC');
            const mailboxes = stmt.all(domain);
            res.json({ success: true, mailboxes });
        } else {
            stmt = db.prepare('SELECT * FROM mailboxes ORDER BY created_at DESC');
            const mailboxes = stmt.all();
            res.json({ success: true, mailboxes });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate and create mailboxes
app.post('/api/generate', async (req, res) => {
    try {
        const { domain, count = 10 } = req.body;

        if (!validDomain(domain) || !Number.isInteger(count) || count < 1 || count > 50) {
            return res.status(400).json({ success: false, error: 'Укажите домен и количество от 1 до 50' });
        }

        const maxCount = count;
        const results = [];
        const errors = [];
        
        for (let i = 0; i < maxCount; i++) {
            const mailboxName = generateMailboxName();
            const password = generatePassword();
            const email = `${mailboxName}@${domain}`;
            
            try {
                // Check if email already exists in local DB
                const existing = db.prepare('SELECT id FROM mailboxes WHERE email = ?').get(email);
                if (existing) {
                    // Generate a new name
                    continue;
                }
                
                // Create mailbox via Beget API
                const result = await rateLimitedRequest(() => 
                    begetApiCall('mail/createMailbox', {
                        domain: domain,
                        mailbox: mailboxName,
                        mailbox_password: password
                    })
                );
                
                if (result.status === 'success' && result.answer?.status === 'success') {
                    // Save to local database
                    const stmt = db.prepare(`
                        INSERT INTO mailboxes (email, password, domain, mailbox_name, last_activity_at)
                        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    `);
                    stmt.run(email, password, domain, mailboxName);
                    
                    results.push({
                        email,
                        password,
                        status: 'created'
                    });
                } else {
                    errors.push({
                        email,
                        error: result.answer?.errors?.[0] || result.answer?.error || 'Unknown error'
                    });
                }
            } catch (error) {
                errors.push({
                    email,
                    error: error.message
                });
            }
        }
        
        res.json({
            success: true,
            created: results,
            errors,
            total: results.length,
            failed: errors.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/inactive-mailboxes', requireAdmin, (req, res) => {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 30));
    const rows = db.prepare(`SELECT id, email, domain, mailbox_name, created_at, last_activity_at,
        CAST(julianday('now') - julianday(last_activity_at) AS INTEGER) AS days_inactive
        FROM mailboxes
        WHERE last_activity_at IS NOT NULL AND last_activity_at < datetime('now', ?)
        ORDER BY last_activity_at ASC, email ASC`).all(`-${days} days`);
    res.json({ days, mailboxes: rows });
});

app.post('/api/admin/inactive-mailboxes/delete', requireAdmin, async (req, res) => {
    const requested = Array.isArray(req.body?.mailboxes) ? req.body.mailboxes : [];
    if (!requested.length || requested.length > 500) {
        return res.status(400).json({ error: 'Выберите от 1 до 500 ящиков' });
    }
    const deleted = [];
    const errors = [];
    for (const item of requested) {
        const domain = typeof item?.domain === 'string' ? item.domain.trim().toLowerCase() : '';
        const mailbox = typeof item?.mailbox === 'string' ? item.mailbox.trim() : '';
        if (!validDomain(domain) || !/^[a-z0-9._+-]{1,64}$/i.test(mailbox)) {
            errors.push({ email: `${mailbox}@${domain}`, error: 'Некорректный ящик' });
            continue;
        }
        try {
            await dropMailboxFromBeget(domain, mailbox);
            const email = `${mailbox}@${domain}`;
            db.prepare('DELETE FROM mailboxes WHERE lower(email) = ?').run(email.toLowerCase());
            deleted.push({ email });
        } catch (error) {
            errors.push({ email: `${mailbox}@${domain}`, error: error.message });
        }
    }
    res.json({ success: errors.length === 0, deleted, errors, total: deleted.length, failed: errors.length });
});

app.post('/api/mailbox/password', async (req, res) => {
    const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim().toLowerCase() : '';
    const mailbox = typeof req.body?.mailbox === 'string' ? req.body.mailbox.trim() : '';
    const password = req.body?.password || generatePassword();

    if (!validDomain(domain) || !/^[a-z0-9._+-]{1,64}$/i.test(mailbox) ||
        typeof password !== 'string' || password.length < 12 || password.length > 128 || /[\r\n]/.test(password)) {
        return res.status(400).json({ success: false, error: 'Проверьте адрес и пароль (12–128 символов)' });
    }

    try {
        const result = await rateLimitedRequest(() => begetApiCall('mail/changeMailboxPassword', {
            domain,
            mailbox,
            mailbox_password: password
        }));
        if (!begetSucceeded(result)) {
            return res.status(502).json({ success: false, error: extractBegetError(result) });
        }
        db.prepare('UPDATE mailboxes SET password = ? WHERE email = ?')
            .run(password, `${mailbox}@${domain}`);
        res.json({ success: true, email: `${mailbox}@${domain}`, password });
    } catch (error) {
        res.status(502).json({ success: false, error: error.message });
    }
});

// Delete mailbox
app.delete('/api/mailbox', async (req, res) => {
    try {
        const { domain, mailbox } = req.body;
        
        if (!domain || !mailbox) {
            return res.status(400).json({ success: false, error: 'Domain and mailbox are required' });
        }
        
        // Delete from Beget
        const result = await rateLimitedRequest(() => 
            begetApiCall('mail/dropMailbox', {
                domain: domain,
                mailbox: mailbox
            })
        );
        
        const requestOk = result?.status === 'success';
        const apiOk = !result?.answer?.status || result.answer.status === 'success';

        if (requestOk && apiOk) {
            // Delete from local database
            const email = `${mailbox}@${domain}`;
            const stmt = db.prepare('DELETE FROM mailboxes WHERE email = ?');
            stmt.run(email);
            
            res.json({ success: true, message: 'Mailbox deleted' });
        } else {
            res.json({ success: false, error: extractBegetError(result, 'Failed to delete mailbox') });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete multiple mailboxes
app.post('/api/mailboxes/delete-multiple', async (req, res) => {
    try {
        const { mailboxes } = req.body; // Array of { domain, mailbox }
        
        if (!mailboxes || !Array.isArray(mailboxes)) {
            return res.status(400).json({ success: false, error: 'Mailboxes array is required' });
        }
        
        const results = [];
        const errors = [];
        
        for (const { domain, mailbox } of mailboxes) {
            try {
                const result = await rateLimitedRequest(() => 
                    begetApiCall('mail/dropMailbox', {
                        domain: domain,
                        mailbox: mailbox
                    })
                );
                
                const requestOk = result?.status === 'success';
                const apiOk = !result?.answer?.status || result.answer.status === 'success';

                if (requestOk && apiOk) {
                    const email = `${mailbox}@${domain}`;
                    const stmt = db.prepare('DELETE FROM mailboxes WHERE email = ?');
                    stmt.run(email);
                    results.push({ email, status: 'deleted' });
                } else {
                    errors.push({ 
                        email: `${mailbox}@${domain}`, 
                        error: extractBegetError(result, 'Failed to delete')
                    });
                }
            } catch (error) {
                errors.push({ 
                    email: `${mailbox}@${domain}`, 
                    error: error.message 
                });
            }
        }
        
        res.json({
            success: true,
            deleted: results,
            errors,
            total: results.length,
            failed: errors.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Export mailboxes
app.get('/api/export', (req, res) => {
    try {
        const { domain, format = 'text' } = req.query;
        let stmt;
        
        if (domain) {
            stmt = db.prepare('SELECT email, password FROM mailboxes WHERE domain = ? ORDER BY created_at DESC');
            var mailboxes = stmt.all(domain);
        } else {
            stmt = db.prepare('SELECT email, password FROM mailboxes ORDER BY created_at DESC');
            var mailboxes = stmt.all();
        }
        
        if (format === 'json') {
            res.json({ success: true, mailboxes });
        } else {
            // Text format: email:password
            const text = mailboxes
                .map(m => m.password ? `${m.email}:${m.password}` : m.email)
                .join('\n');
            res.type('text/plain').send(text);
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check API connection
app.get('/api/check-connection', async (req, res) => {
    try {
        const result = await begetApiCall('user/getAccountInfo');

        const requestOk = result?.status === 'success';
        const apiOk = !result?.answer?.status || result.answer.status === 'success';

        if (requestOk && apiOk) {
            res.json({ 
                success: true, 
                message: 'Connected to Beget API',
                user: result.answer?.result?.user_login || BEGET_LOGIN
            });
        } else {
            res.json({ success: false, error: extractBegetError(result, 'Failed to connect to Beget API') });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start server
app.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║     Beget Mail Generator - Web Panel                       ║
╠════════════════════════════════════════════════════════════╣
║  Server running at: http://${HOST}:${PORT}                    ║
║  API Status: ${BEGET_LOGIN ? 'Configured' : 'NOT CONFIGURED - Check .env file'}                              ║
╚════════════════════════════════════════════════════════════╝
    `);
});
