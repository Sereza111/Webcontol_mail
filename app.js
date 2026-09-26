require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

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

// API Routes

// Get list of domains
app.get('/api/domains', async (req, res) => {
    try {
        const result = await rateLimitedRequest(() => begetApiCall('domain/getList'));

        const requestOk = result?.status === 'success';
        const apiOk = !result?.answer?.status || result.answer.status === 'success';
        const domainsList = Array.isArray(result?.answer?.result) ? result.answer.result : [];

        if (requestOk && apiOk) {
            const domains = domainsList.map(d => ({
                id: d.id,
                fqdn: d.fqdn
            }));
            res.json({ success: true, domains });
        } else {
            res.json({ success: false, error: extractBegetError(result, 'Failed to get domains') });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
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
            return res.json({ success: true, domain, alreadyExists: true });
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
        res.status(201).json({ success: true, domain, id: added.answer?.result });
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
                        INSERT INTO mailboxes (email, password, domain, mailbox_name)
                        VALUES (?, ?, ?, ?)
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
