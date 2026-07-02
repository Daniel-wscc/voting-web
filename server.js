const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');

// --- Configuration ---
const PORT = process.env.PORT || 6500;
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
        
        // Enforce SQLite Foreign Key constraints for Cascade Deletes
        db.run("PRAGMA foreign_keys = ON;", (err) => {
            if (err) console.error("啟用外鍵約束失敗:", err);
            else console.log("SQLite 外鍵約束（Foreign Keys）已成功啟用。");
        });
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS polls (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        createdAt TEXT NOT NULL,
        deletePassword TEXT,
        allowMultiple INTEGER DEFAULT 0,
        allowUserOptions INTEGER DEFAULT 1,
        imageUrl TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS options (
        id TEXT PRIMARY KEY,
        pollId TEXT NOT NULL,
        text TEXT NOT NULL,
        FOREIGN KEY(pollId) REFERENCES polls(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS votes (
        pollId TEXT NOT NULL,
        optionId TEXT NOT NULL,
        voterId TEXT NOT NULL,
        username TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        avatarUrl TEXT,
        PRIMARY KEY (pollId, voterId, optionId),
        FOREIGN KEY(pollId) REFERENCES polls(id) ON DELETE CASCADE,
        FOREIGN KEY(optionId) REFERENCES options(id) ON DELETE CASCADE
    )`);

    // Self-healing migrations for existing databases
    db.run("ALTER TABLE polls ADD COLUMN allowMultiple INTEGER DEFAULT 0", (err) => {
        // Ignore errors if columns already exist
    });
    db.run("ALTER TABLE polls ADD COLUMN allowUserOptions INTEGER DEFAULT 1", (err) => {
        // Ignore errors if columns already exist
    });
    db.run("ALTER TABLE polls ADD COLUMN imageUrl TEXT", (err) => {
        // Ignore errors if columns already exist
    });
    db.run("ALTER TABLE votes ADD COLUMN avatarUrl TEXT", (err) => {
        // Ignore errors if columns already exist
    });

    // Migration: Migrate votes table primary key if it is old (only 2 columns)
    db.all("PRAGMA table_info(votes)", (err, columns) => {
        if (err || !columns) return;
        
        // Count primary key columns
        const pkColumns = columns.filter(col => col.pk > 0);
        if (pkColumns.length > 0 && pkColumns.length < 3) {
            console.log("⚠️ 檢測到舊版選票資料表主鍵結構，正在自動升級為多選聯合主鍵...");
            
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                db.run("ALTER TABLE votes RENAME TO votes_old");
                
                db.run(`CREATE TABLE votes (
                    pollId TEXT NOT NULL,
                    optionId TEXT NOT NULL,
                    voterId TEXT NOT NULL,
                    username TEXT NOT NULL,
                    createdAt TEXT NOT NULL,
                    avatarUrl TEXT,
                    PRIMARY KEY (pollId, voterId, optionId),
                    FOREIGN KEY(pollId) REFERENCES polls(id) ON DELETE CASCADE,
                    FOREIGN KEY(optionId) REFERENCES options(id) ON DELETE CASCADE
                )`);
                
                // Copy data, ensuring we only copy unique combinations of pollId, optionId, voterId
                db.run(`INSERT OR IGNORE INTO votes (pollId, optionId, voterId, username, createdAt, avatarUrl) 
                        SELECT pollId, optionId, voterId, username, createdAt, avatarUrl FROM votes_old`);
                
                db.run("DROP TABLE votes_old");
                db.run("COMMIT", (err) => {
                    if (err) console.error("升級多選主鍵失敗:", err);
                    else console.log("✅ 選票資料表主鍵升級成功！已支援多選投票。");
                });
            });
        }
    });

    // Check database status
    db.get("SELECT COUNT(*) as count FROM polls", (err, row) => {
        if (err) {
            console.error("檢查資料表時發生錯誤:", err);
            return;
        }
        console.log(`資料庫連線成功。目前有 ${row ? row.count : 0} 個投票主題。`);
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
            
            db.all("SELECT * FROM votes ORDER BY createdAt ASC", (err, votes) => {
                if (err) return callback(err);
                
                const pollsMap = polls.map(p => {
                    const pollOptions = options
                        .filter(o => o.pollId === p.id)
                        .map(o => {
                            const optionVotes = votes.filter(v => v.optionId === o.id);
                            return {
                                id: o.id,
                                text: o.text,
                                votes: optionVotes.length,
                                voters: optionVotes.map(v => ({ voterId: v.voterId, username: v.username, avatarUrl: v.avatarUrl }))
                            };
                        });
                        
                    return {
                        id: p.id,
                        title: p.title,
                        description: p.description,
                        createdAt: p.createdAt,
                        hasPassword: p.deletePassword && p.deletePassword.trim() !== '' ? true : false,
                        allowMultiple: p.allowMultiple === 1,
                        allowUserOptions: p.allowUserOptions === 1,
                        imageUrl: p.imageUrl,
                        options: pollOptions
                    };
                });
                
                callback(null, pollsMap);
            });
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
    const { title, description, options, deletePassword, allowMultiple, allowUserOptions, image } = req.body;
    
    if (!title || !options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ error: '主題與至少兩個選項為必填項目。' });
    }
    
    const pollId = `poll_${Date.now()}`;
    const createdAt = new Date().toISOString();
    
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        
        db.run(
            "INSERT INTO polls (id, title, description, createdAt, deletePassword, allowMultiple, allowUserOptions, imageUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                pollId, 
                title, 
                description || '', 
                createdAt, 
                deletePassword || null, 
                allowMultiple ? 1 : 0, 
                allowUserOptions ? 1 : 0, 
                image || null
            ],
            (err) => {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: '建立投票失敗: ' + err.message });
                }
                
                const stmtOpt = db.prepare("INSERT INTO options (id, pollId, text) VALUES (?, ?, ?)");
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
    
    db.get("SELECT id FROM polls WHERE id = ?", [pollId], (err, poll) => {
        if (err || !poll) {
            return res.status(404).json({ error: '找不到該投票主題。' });
        }
        
        const optionId = `opt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        
        db.run(
            "INSERT INTO options (id, pollId, text) VALUES (?, ?, ?)",
            [optionId, pollId, text],
            (err) => {
                if (err) {
                    return res.status(500).json({ error: '新增選項失敗: ' + err.message });
                }
                
                broadcastUpdates();
                res.status(201).json({ id: optionId, text, voters: [] });
            }
        );
    });
});

// Vote / retract vote on an option
app.post('/api/polls/:id/vote', (req, res) => {
    const pollId = req.params.id;
    const { optionId, voterId, username, increment, avatarUrl } = req.body; // increment: 1 (vote) or -1 (retract)
    
    if (!optionId || !voterId || !username || (increment !== 1 && increment !== -1)) {
        return res.status(400).json({ error: '不正確的投票參數。' });
    }
    
    db.get("SELECT allowMultiple FROM polls WHERE id = ?", [pollId], (err, poll) => {
        if (err || !poll) {
            return res.status(404).json({ error: '找不到該投票主題。' });
        }
        
        const isMultiple = poll.allowMultiple === 1;
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            
            if (increment === -1) {
                db.run(
                    "DELETE FROM votes WHERE pollId = ? AND voterId = ? AND optionId = ?",
                    [pollId, voterId, optionId],
                    (err) => {
                        if (err) {
                            db.run("ROLLBACK");
                            return res.status(500).json({ error: '取消投票失敗: ' + err.message });
                        }
                        db.run("COMMIT", (err) => {
                            if (err) return res.status(500).json({ error: err.message });
                            broadcastUpdates();
                            res.json({ success: true });
                        });
                    }
                );
            } else {
                // If single-choice mode, delete any previous votes by this user in this poll first
                if (!isMultiple) {
                    db.run("DELETE FROM votes WHERE pollId = ? AND voterId = ?", [pollId, voterId]);
                }
                
                const createdAt = new Date().toISOString();
                db.run(
                    "INSERT OR REPLACE INTO votes (pollId, optionId, voterId, username, createdAt, avatarUrl) VALUES (?, ?, ?, ?, ?, ?)",
                    [pollId, optionId, voterId, username, createdAt, avatarUrl || null],
                    (err) => {
                        if (err) {
                            db.run("ROLLBACK");
                            return res.status(500).json({ error: '寫入選票失敗: ' + err.message });
                        }
                        db.run("COMMIT", (err) => {
                            if (err) return res.status(500).json({ error: err.message });
                            broadcastUpdates();
                            res.json({ success: true });
                        });
                    }
                );
            }
        });
    });
});

// Moderated Delete Option Vote
app.post('/api/polls/:id/votes/delete', (req, res) => {
    const pollId = req.params.id;
    const { optionId, voterId, password } = req.body;
    
    if (!optionId || !voterId) {
        return res.status(400).json({ error: '選項 ID 與投票者識別碼為必填。' });
    }
    
    db.get("SELECT deletePassword FROM polls WHERE id = ?", [pollId], (err, poll) => {
        if (err || !poll) {
            return res.status(404).json({ error: '找不到該投票主題。' });
        }
        
        // If password protection is configured, check password correctness
        if (poll.deletePassword && poll.deletePassword.trim() !== '') {
            if (poll.deletePassword !== password) {
                return res.status(403).json({ error: '密碼錯誤，無法剔除此投票！' });
            }
        }
        
        db.run(
            "DELETE FROM votes WHERE pollId = ? AND optionId = ? AND voterId = ?",
            [pollId, optionId, voterId],
            (err) => {
                if (err) {
                    return res.status(500).json({ error: '剔除選票失敗: ' + err.message });
                }
                
                broadcastUpdates();
                res.json({ success: true });
            }
        );
    });
});

// Verify poll password for entering management mode
app.post('/api/polls/:id/verify-password', (req, res) => {
    const pollId = req.params.id;
    const { password } = req.body;
    
    db.get("SELECT deletePassword FROM polls WHERE id = ?", [pollId], (err, poll) => {
        if (err || !poll) {
            return res.status(404).json({ error: '找不到該投票主題。' });
        }
        
        if (poll.deletePassword && poll.deletePassword.trim() !== '') {
            if (poll.deletePassword !== password) {
                return res.status(403).json({ error: '密碼錯誤！' });
            }
        }
        
        res.json({ success: true });
    });
});

// Delete entire poll topic
app.post('/api/polls/:id/delete', (req, res) => {
    const pollId = req.params.id;
    const { password } = req.body;
    
    db.get("SELECT deletePassword FROM polls WHERE id = ?", [pollId], (err, poll) => {
        if (err || !poll) {
            return res.status(404).json({ error: '找不到該投票主題。' });
        }
        
        if (poll.deletePassword && poll.deletePassword.trim() !== '') {
            if (poll.deletePassword !== password) {
                return res.status(403).json({ error: '密碼錯誤，無法刪除此投票主題！' });
            }
        }
        
        db.run("DELETE FROM polls WHERE id = ?", [pollId], (err) => {
            if (err) {
                return res.status(500).json({ error: '刪除投票主題失敗: ' + err.message });
            }
            
            broadcastUpdates();
            res.json({ success: true });
        });
    });
});

// Update profile (username & avatar) in all existing votes
app.post('/api/users/update-profile', (req, res) => {
    const { voterId, username, avatarUrl } = req.body;
    
    if (!voterId || !username) {
        return res.status(400).json({ error: 'voterId 與 username 為必填。' });
    }
    
    db.run(
        "UPDATE votes SET username = ?, avatarUrl = ? WHERE voterId = ?",
        [username, avatarUrl || null, voterId],
        (err) => {
            if (err) {
                return res.status(500).json({ error: '更新個人資料失敗: ' + err.message });
            }
            
            broadcastUpdates();
            res.json({ success: true });
        }
    );
});

// Catch-all route to serve index.html for SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`伺服器運作中！連接埠：http://localhost:${PORT}`);
});
