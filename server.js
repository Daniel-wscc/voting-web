const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'voting.db');

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// --- Initialize SQLite Database ---
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('無法連線至 SQLite 資料庫:', err.message);
    } else {
        console.log('已成功連線至 SQLite 資料庫:', DB_PATH);
    }
});

// Seed default polls definition
const DEFAULT_POLLS = [
    {
        id: 'poll_seed_1',
        title: '2026 年最期待的科技趨勢是什麼？',
        description: '隨著技術飛速發展，哪一項科技變革將在 2026 年對人類社會與工作型態帶來最深遠的影響？',
        createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
        options: [
            { id: 'opt_s1_1', text: 'AI 代理與自主工作流 (Autonomous AI Agents)', votes: 42 },
            { id: 'opt_s1_2', text: '通用人工智慧突破 (AGI Breakthrough)', votes: 28 },
            { id: 'opt_s1_3', text: '空間運算與輕量化 AR 眼鏡 (Spatial Computing)', votes: 15 },
            { id: 'opt_s1_4', text: '量子運算雲端商用化 (Commercial Quantum Computing)', votes: 8 }
        ]
    },
    {
        id: 'poll_seed_2',
        title: '下一次團隊聚餐想吃什麼？',
        description: '辛勤工作後的放鬆聚會！請大家投下神聖的一票，我們將依據投票結果訂位。如果有其他想吃的也可以自行新增！',
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        options: [
            { id: 'opt_s2_1', text: '經典麻辣鴛鴦火鍋', votes: 12 },
            { id: 'opt_s2_2', text: '日式炭火串燒居酒屋', votes: 18 },
            { id: 'opt_s2_3', text: '美式精釀啤酒餐酒館', votes: 9 },
            { id: 'opt_s2_4', text: '米其林精緻無菜單法式料理', votes: 5 }
        ]
    },
    {
        id: 'poll_seed_3',
        title: '您最喜愛或最常使用的程式語言是？',
        description: '開發者生態調查！不管是前端、後端、系統開發或 AI，哪款語言是你的生產力首選？',
        createdAt: new Date(Date.now() - 86400000 * 7).toISOString(),
        options: [
            { id: 'opt_s3_1', text: 'TypeScript / JavaScript', votes: 56 },
            { id: 'opt_s3_2', text: 'Rust', votes: 31 },
            { id: 'opt_s3_3', text: 'Python', votes: 45 },
            { id: 'opt_s3_4', text: 'Go', votes: 22 },
            { id: 'opt_s3_5', text: 'Kotlin / Swift', votes: 11 }
        ]
    }
];

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS polls (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        createdAt TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS options (
        id TEXT PRIMARY KEY,
        pollId TEXT NOT NULL,
        text TEXT NOT NULL,
        votes INTEGER DEFAULT 0,
        FOREIGN KEY(pollId) REFERENCES polls(id) ON DELETE CASCADE
    )`);

    // Check if database needs seeding
    db.get("SELECT COUNT(*) as count FROM polls", (err, row) => {
        if (err) {
            console.error("檢查資料表時發生錯誤:", err);
            return;
        }
        if (row.count === 0) {
            console.log("資料庫無資料，開始寫入預設投票主題...");
            
            const stmtPoll = db.prepare("INSERT INTO polls (id, title, description, createdAt) VALUES (?, ?, ?, ?)");
            const stmtOpt = db.prepare("INSERT INTO options (id, pollId, text, votes) VALUES (?, ?, ?, ?)");
            
            DEFAULT_POLLS.forEach(poll => {
                stmtPoll.run(poll.id, poll.title, poll.description, poll.createdAt);
                poll.options.forEach(opt => {
                    stmtOpt.run(opt.id, poll.id, opt.text, opt.votes);
                });
            });
            
            stmtPoll.finalize();
            stmtOpt.finalize();
            console.log("預設投票主題寫入完畢！");
        }
    });
});

// --- Initialize Express ---
const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Create Server
const server = http.createServer(app);

// --- Initialize WebSockets ---
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('新增一個 WebSocket 連線，目前連線數:', wss.clients.size);
    
    ws.on('close', () => {
        console.log('一個 WebSocket 連線已關閉，剩餘連線數:', wss.clients.size);
    });
});

// Broadcast Helper
function broadcastUpdates() {
    getAllPollsData((err, pollsData) => {
        if (err) {
            console.error("廣播讀取資料錯誤:", err);
            return;
        }
        
        const message = JSON.stringify({
            type: 'POLLS_UPDATED',
            polls: pollsData
        });
        
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });
}

// Database Read Helper
function getAllPollsData(callback) {
    db.all("SELECT * FROM polls ORDER BY createdAt DESC", (err, polls) => {
        if (err) return callback(err);
        
        db.all("SELECT * FROM options", (err, options) => {
            if (err) return callback(err);
            
            const pollsMap = polls.map(p => ({
                id: p.id,
                title: p.title,
                description: p.description,
                createdAt: p.createdAt,
                options: options
                    .filter(o => o.pollId === p.id)
                    .map(o => ({ id: o.id, text: o.text, votes: o.votes }))
            }));
            
            callback(null, pollsMap);
        });
    });
}

// --- Express API Router ---

// Get all polls
app.get('/api/polls', (req, res) => {
    getAllPollsData((err, pollsData) => {
        if (err) {
            return res.status(500).json({ error: '讀取投票主題失敗: ' + err.message });
        }
        res.json(pollsData);
    });
});

// Create a new poll
app.post('/api/polls', (req, res) => {
    const { title, description, options } = req.body;
    
    if (!title || !options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ error: '主題與至少兩個選項為必填項目。' });
    }
    
    const pollId = `poll_${Date.now()}`;
    const createdAt = new Date().toISOString();
    
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        
        db.run(
            "INSERT INTO polls (id, title, description, createdAt) VALUES (?, ?, ?, ?)",
            [pollId, title, description || '', createdAt],
            (err) => {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: '建立投票失敗: ' + err.message });
                }
                
                const stmtOpt = db.prepare("INSERT INTO options (id, pollId, text, votes) VALUES (?, ?, ?, 0)");
                options.forEach(optText => {
                    const optId = `opt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                    stmtOpt.run(optId, pollId, optText);
                });
                
                stmtOpt.finalize((err) => {
                    if (err) {
                        db.run("ROLLBACK");
                        return res.status(500).json({ error: '新增初始選項失敗: ' + err.message });
                    }
                    
                    db.run("COMMIT", (err) => {
                        if (err) {
                            return res.status(500).json({ error: '提交交易失敗: ' + err.message });
                        }
                        
                        // Success - Broadcast updates and return response
                        broadcastUpdates();
                        res.status(201).json({ id: pollId, title, description, createdAt });
                    });
                });
            }
        );
    });
});

// Add option to existing poll
app.post('/api/polls/:id/options', (req, res) => {
    const pollId = req.params.id;
    const { text } = req.body;
    
    if (!text) {
        return res.status(400).json({ error: '選項內容為必填。' });
    }
    
    // First verify if poll exists
    db.get("SELECT id FROM polls WHERE id = ?", [pollId], (err, poll) => {
        if (err || !poll) {
            return res.status(404).json({ error: '找不到該投票主題。' });
        }
        
        const optionId = `opt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        
        db.run(
            "INSERT INTO options (id, pollId, text, votes) VALUES (?, ?, ?, 0)",
            [optionId, pollId, text],
            (err) => {
                if (err) {
                    return res.status(500).json({ error: '新增選項失敗: ' + err.message });
                }
                
                broadcastUpdates();
                res.status(201).json({ id: optionId, text, votes: 0 });
            }
        );
    });
});

// Vote / retract vote on an option
app.post('/api/polls/:id/vote', (req, res) => {
    const pollId = req.params.id;
    const { optionId, increment } = req.body; // increment: 1 (vote) or -1 (retract)
    
    if (!optionId || (increment !== 1 && increment !== -1)) {
        return res.status(400).json({ error: '不正確的投票參數。' });
    }
    
    // Check if option belongs to this poll
    db.get("SELECT id, votes FROM options WHERE id = ? AND pollId = ?", [optionId, pollId], (err, option) => {
        if (err || !option) {
            return res.status(404).json({ error: '選項與投票主題不符或不存在。' });
        }
        
        // Calculate new votes (never drop below 0)
        const newVotes = Math.max(0, option.votes + increment);
        
        db.run(
            "UPDATE options SET votes = ? WHERE id = ? AND pollId = ?",
            [newVotes, optionId, pollId],
            (err) => {
                if (err) {
                    return res.status(500).json({ error: '更新票數失敗: ' + err.message });
                }
                
                broadcastUpdates();
                res.json({ success: true, optionId, votes: newVotes });
            }
        );
    });
});

// Catch-all route to serve index.html for SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`伺服器運作中！連接埠：http://localhost:${PORT}`);
});
