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

// Initialize SQLite database
const db = new Database('mailboxes.db');
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
    const length = Math.floor(Math.random() * 8) + 5; // 5-12 characters
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    // First character should be a letter
    result += chars.charAt(Math.floor(Math.random() * 26));
    for (let i = 1; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Generate random password (12+ characters with letters, numbers, and symbols)
function generatePassword() {
    const length = Math.floor(Math.random() * 5) + 12; // 12-16 characters
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const symbols = '!@#$%^&*()_+-=[]{}';
    const allChars = lowercase + uppercase + numbers + symbols;
    
    // Ensure at least one of each type
    let password = '';
    password += lowercase.charAt(Math.floor(Math.random() * lowercase.length));
    password += uppercase.charAt(Math.floor(Math.random() * uppercase.length));
    password += numbers.charAt(Math.floor(Math.random() * numbers.length));
    password += symbols.charAt(Math.floor(Math.random() * symbols.length));
    
    // Fill the rest
    for (let i = 4; i < length; i++) {
        password += allChars.charAt(Math.floor(Math.random() * allChars.length));
    }
    
    // Shuffle password
    return password.split('').sort(() => Math.random() - 0.5).join('');
}

// Beget API call helper
async function begetApiCall(method, params = {}) {
    const url = `${BEGET_API_BASE}/${method}`;
    const queryParams = new URLSearchParams({
        login: BEGET_LOGIN,
        passwd: BEGET_PASSWORD,
        input_format: 'json',
        output_format: 'json',
        input_data: JSON.stringify(params)
    });
    
    try {
        const response = await axios.get(`${url}?${queryParams.toString()}`);
        return response.data;
    } catch (error) {
        console.error(`API Error (${method}):`, error.message);
        throw error;
    }
}

// API Routes

// Get list of domains
app.get('/api/domains', async (req, res) => {
    try {
        const result = await rateLimitedRequest(() => begetApiCall('domain/getList'));
        
        if (result.status === 'success' && result.answer && result.answer.result) {
            const domains = result.answer.result.map(d => ({
                id: d.id,
                fqdn: d.fqdn
            }));
            res.json({ success: true, domains });
        } else {
            res.json({ success: false, error: result.answer?.error || 'Failed to get domains' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get mailbox list for a domain
app.get('/api/mailboxes/:domain', async (req, res) => {
    try {
        const { domain } = req.params;
        const result = await rateLimitedRequest(() => begetApiCall('mail/getMailboxList', { domain }));
        
        if (result.status === 'success') {
            res.json({ success: true, mailboxes: result.answer?.result || [] });
        } else {
            res.json({ success: false, error: result.answer?.error || 'Failed to get mailboxes' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
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
        
        if (!domain) {
            return res.status(400).json({ success: false, error: 'Domain is required' });
        }
        
        const maxCount = Math.min(count, 50); // Limit to 50 per request
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
        
        if (result.status === 'success') {
            // Delete from local database
            const email = `${mailbox}@${domain}`;
            const stmt = db.prepare('DELETE FROM mailboxes WHERE email = ?');
            stmt.run(email);
            
            res.json({ success: true, message: 'Mailbox deleted' });
        } else {
            res.json({ success: false, error: result.answer?.error || 'Failed to delete mailbox' });
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
                
                if (result.status === 'success') {
                    const email = `${mailbox}@${domain}`;
                    const stmt = db.prepare('DELETE FROM mailboxes WHERE email = ?');
                    stmt.run(email);
                    results.push({ email, status: 'deleted' });
                } else {
                    errors.push({ 
                        email: `${mailbox}@${domain}`, 
                        error: result.answer?.error || 'Failed to delete' 
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
            const text = mailboxes.map(m => `${m.email}:${m.password}`).join('\n');
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
        
        if (result.status === 'success') {
            res.json({ 
                success: true, 
                message: 'Connected to Beget API',
                user: result.answer?.result?.user_login || BEGET_LOGIN
            });
        } else {
            res.json({ success: false, error: 'Failed to connect to Beget API' });
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
