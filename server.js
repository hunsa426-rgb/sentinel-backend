require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
app.use(cors({ origin: '*' })); 
// ✅ เพิ่ม limit เป็น 50mb เพื่อรองรับ Tree ขนาดใหญ่จาก Roblox
app.use(express.json({ limit: '50mb' })); 

const SECRET = process.env.TELEMETRY_SECRET || 'dev-secret';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '1234';

// ==========================================
// 1. Database Setup (Render Ready)
// ==========================================
// ✅ ใช้โฟลเดอร์ /tmp สำหรับ Render Free Tier เพื่อป้องกันปัญหา Permission Denied
const dbPath = process.env.DB_PATH || '/tmp/sentinel.db'; 
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS bans (user_id INTEGER PRIMARY KEY, reason TEXT, added_at INTEGER);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, target TEXT, reason TEXT, created_at INTEGER);
`);

const servers = new Map();
const sessions = new Map();
const actionQueues = new Map();

// ==========================================
// 2. Dynamic Config (Default values)
// ==========================================
let globalConfig = {
    maxWalkSpeed: 50,
    maxJumpPower: 120,
    maxTeleportDelta: 50,
    maxRemoteSpamRate: 30,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "" 
};

// ==========================================
// 3. Discord Webhook Helper
// ==========================================
async function sendDiscordNotification(title, description, color = 15158332) { // Default: Red
    if (!globalConfig.discordWebhookUrl) return;
    try {
        await fetch(globalConfig.discordWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: title,
                    description: description,
                    color: color,
                    timestamp: new Date().toISOString(),
                    footer: { text: "Sentinel Watchdog" }
                }]
            })
        });
    } catch (e) { console.error("Discord Webhook Error:", e.message); }
}

// ==========================================
// 4. Auth & Dashboard APIs
// ==========================================
app.post('/api/auth/login', (req, res) => {
    const { password } = req.body;
    if (password !== PASSWORD) return res.status(401).json({ success: false, error: 'Invalid password' });
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, Date.now() + 8 * 3600 * 1000);
    res.json({ success: true, token });
});

const auth = (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

app.get('/api/servers', auth, (req, res) => {
    const list = Array.from(servers.values()).map(s => ({
        serverId: s.serverId, gameName: s.gameName, playerCount: s.playerCount, alertCount: s.alerts ? s.alerts.length : 0
    }));
    res.json({ servers: list });
});

app.get('/api/servers/:id', auth, (req, res) => {
    const s = servers.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Server not found' });
    res.json(s);
});

// --- Ban List APIs ---
app.get('/api/bans', auth, (req, res) => {
    const bans = db.prepare('SELECT * FROM bans ORDER BY added_at DESC').all();
    res.json({ bans });
});

app.post('/api/bans', auth, (req, res) => {
    const { userId, reason } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing UserId' });
    db.prepare('INSERT OR REPLACE INTO bans (user_id, reason, added_at) VALUES (?, ?, ?)').run(userId, reason, Date.now());
    
    // ✅ แจ้งเตือน Discord เมื่อแบนผ่านหน้าเว็บ
    sendDiscordNotification("🔨 Manual Ban Added", `**User ID:** ${userId}\n**Reason:** ${reason}`, 15548997);
    res.json({ success: true });
});

app.delete('/api/bans/:id', auth, (req, res) => {
    db.prepare('DELETE FROM bans WHERE user_id = ?').run(req.params.id);
    res.json({ success: true });
});

// --- Audit Log ---
app.get('/api/audit', auth, (req, res) => {
    const logs = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100').all();
    res.json({ logs });
});

// --- Config ---
app.get('/api/config', auth, (req, res) => {
    res.json(globalConfig);
});

app.post('/api/config', auth, (req, res) => {
    const { maxWalkSpeed, maxJumpPower, maxTeleportDelta, maxRemoteSpamRate, discordWebhookUrl } = req.body;
    globalConfig = {
        maxWalkSpeed: Number(maxWalkSpeed) || globalConfig.maxWalkSpeed,
        maxJumpPower: Number(maxJumpPower) || globalConfig.maxJumpPower,
        maxTeleportDelta: Number(maxTeleportDelta) || globalConfig.maxTeleportDelta,
        maxRemoteSpamRate: Number(maxRemoteSpamRate) || globalConfig.maxRemoteSpamRate,
        discordWebhookUrl: discordWebhookUrl !== undefined ? discordWebhookUrl : globalConfig.discordWebhookUrl
    };
    res.json({ success: true, config: globalConfig });
});

// --- Action (Kick/Ban จาก Dashboard) ---
app.post('/api/action', auth, (req, res) => {
    const { serverId, playerName, actionType, reason } = req.body;
    if (!servers.has(serverId)) return res.status(404).json({ error: 'Server offline' });
    
    if (!actionQueues.has(serverId)) actionQueues.set(serverId, []);
    actionQueues.get(serverId).push({ playerName, actionType, reason });

    // บันทึก Audit Log
    db.prepare('INSERT INTO audit_log (action, target, reason, created_at) VALUES (?, ?, ?, ?)').run(actionType, playerName, reason, Date.now());
    
    // ✅ แจ้งเตือน Discord เมื่อสั่งการจาก Dashboard
    const actionNames = { kick: '👢 Kick', temp_ban: '⏳ Temp Ban', perm_ban: '🔨 Perm Ban' };
    const actionColors = { kick: 16753920, temp_ban: 16753920, perm_ban: 15548997 };
    sendDiscordNotification(`${actionNames[actionType]} Executed`, `**Target:** ${playerName}\n**Reason:** ${reason}`, actionColors[actionType]);

    res.json({ success: true });
});

// ==========================================
// 5. Telemetry (Roblox ส่งข้อมูลเข้ามา)
// ==========================================
app.post('/api/telemetry', (req, res) => {
    if (req.headers['x-secret'] !== SECRET) return res.status(403).send('Forbidden');
    
    const { serverId, gameName, playerCount, tree, alerts, players } = req.body;
    
    if (serverId) {
        const existing = servers.get(serverId) || { alerts: [] };
        let combinedAlerts = existing.alerts;
        
        // ✅ ตรวจสอบ Alert ใหม่ และส่งแจ้งเตือน Discord
        if (alerts && alerts.length > 0) {
            combinedAlerts = [...alerts, ...combinedAlerts].slice(0, 50);
            alerts.forEach(alert => {
                if (alert.confidence >= 80) { 
                    sendDiscordNotification(`🚨 Cheat Detected: ${alert.message}`, `**Player:** ${alert.playerName}\n**Confidence:** ${alert.confidence}%`, 15548997);
                }
            });
        }

        // อัปเดตข้อมูล Server ใน Memory
        servers.set(serverId, {
            serverId, gameName: gameName || 'Unknown', playerCount: playerCount || 0,
            tree: tree || [], players: players || [], alerts: combinedAlerts, lastUpdated: Date.now()
        });

        // ดึงคิวคำสั่งและ Banlist ส่งกลับไปให้ Roblox
        const actions = actionQueues.has(serverId) ? actionQueues.get(serverId) : [];
        actionQueues.delete(serverId); 
        const banlist = db.prepare('SELECT user_id, reason FROM bans').all();

        return res.json({ success: true, actions, banlist, config: globalConfig });
    }
    res.status(400).json({ error: 'Invalid data' });
});

// ==========================================
// 6. Start Server (Render Ready)
// ==========================================
const PORT = process.env.PORT || 3000;

// ✅ Bind to 0.0.0.0 เพื่อให้ Render เข้าถึงพอร์ตได้
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Sentinel Backend running on port ${PORT}`);
    console.log(`✅ Database loaded from: ${dbPath}`);
});