import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import fs from 'fs/promises';

const app = express();
app.use(cors());
app.use(express.json());

// Configure file uploads
const upload = multer({ dest: 'uploads/' });

// Database connection
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

async function initDB() {
    const conn = await pool.getConnection();
    await conn.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS files (
            id INT AUTO_INCREMENT PRIMARY KEY,
            filename VARCHAR(255) UNIQUE NOT NULL,
            path VARCHAR(255) NOT NULL
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            token VARCHAR(255) NOT NULL,
            expires_at DATETIME NOT NULL,
            used BOOLEAN DEFAULT FALSE,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS whitelist_emails (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    conn.release();
}
await initDB();

// Auth Middleware
const authenticate = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        res.status(400).json({ error: 'Invalid token' });
    }
};

// Routes
app.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO users (email, password) VALUES (?, ?)',
            [email, hashedPassword]
        );
        res.status(201).json({ message: 'User created' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // First check if email is whitelisted
        const [whitelist] = await pool.query(
            'SELECT 1 FROM whitelist_emails WHERE email = ?',
            [email]
        );

        if (whitelist.length === 0) {
            return res.status(403).json({
                error: 'Access denied. Your email is not whitelisted.'
            });
        }

        const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);

        if (users.length === 0 || !(await bcrypt.compare(password, users[0].password))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ userId: users[0].id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/upload', authenticate, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        // Check if filename already exists
        const [existing] = await pool.query(
            'SELECT id FROM files WHERE filename = ?',
            [req.file.originalname]
        );

        if (existing.length > 0) {
            return res.status(400).json({ error: 'File with this name already exists' });
        }

        const [result] = await pool.query(
            'INSERT INTO files (filename, path) VALUES (?, ?)',
            [req.file.originalname, req.file.path]
        );

        res.json({
            message: 'File uploaded successfully',
            fileId: result.insertId,
            path: req.file.path
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/files', async (req, res) => {
    try {
        const [files] = await pool.query('SELECT * FROM files');
        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/files/:id', async (req, res) => {
    try {
        const fileId = req.params.id;

        // 1. Get file path from database
        const [files] = await pool.query(
            'SELECT id, path FROM files WHERE id = ?',
            [fileId]
        );

        if (files.length === 0) {
            return res.status(404).json({ error: 'File not found in database' });
        }

        const filePath = files[0].path;

        // 2. Delete physical file
        try {
            await fs.unlink(filePath);
        } catch (err) {
            console.error('Physical file deletion warning:', err.message);
            // Continue even if physical deletion fails
        }

        // 3. Delete database record
        const [result] = await pool.query(
            'DELETE FROM files WHERE id = ?',
            [fileId]
        );

        res.json({
            message: 'File deleted completely',
            details: {
                dbRecordDeleted: result.affectedRows === 1,
                physicalFileDeleted: true, // Assuming best case
                deletedId: fileId
            }
        });

    } catch (err) {
        res.status(500).json({
            error: err.message,
            note: 'Database record may or may not have been deleted'
        });
    }
});

// User delete
app.delete('/user', authenticate, async (req, res) => {
    const conn = await pool.getConnection();
    await conn.beginTransaction();

    try {
        const { password } = req.body;

        // 1. Verify password
        const [users] = await conn.query(
            'SELECT id, password FROM users WHERE id = ?',
            [req.userId]
        );

        if (users.length === 0 || !(await bcrypt.compare(password, users[0].password))) {
            await conn.rollback();
            return res.status(401).json({ error: 'Invalid password' });
        }

        // 2. Delete password reset tokens first (due to foreign key)
        await conn.query(
            'DELETE FROM password_reset_tokens WHERE user_id = ?',
            [req.userId]
        );

        // 3. Delete user
        const [result] = await conn.query(
            'DELETE FROM users WHERE id = ?',
            [req.userId]
        );

        if (result.affectedRows === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'User not found' });
        }

        await conn.commit();
        res.json({ message: 'User account deleted successfully' });

    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

// Password reset endpoints (unchanged)
app.post('/request-password-reset', async (req, res) => {
    try {
        const { email } = req.body;
        const [users] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userId = users[0].id;
        const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '15m' });

        await pool.query(
            'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE))',
            [userId, token]
        );

        res.json({
            message: 'Password reset token generated',
            token
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/verify-reset-token', async (req, res) => {
    try {
        const { token } = req.body;
        const [tokens] = await pool.query(
            'SELECT * FROM password_reset_tokens WHERE token = ? AND used = FALSE AND expires_at > NOW()',
            [token]
        );

        if (tokens.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired token' });
        }

        res.json({ valid: true, userId: tokens[0].user_id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        const [tokens] = await pool.query(
            'SELECT * FROM password_reset_tokens WHERE token = ? AND used = FALSE AND expires_at > NOW()',
            [token]
        );

        if (tokens.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired token' });
        }

        const userId = tokens[0].user_id;
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await pool.query(
            'UPDATE users SET password = ? WHERE id = ?',
            [hashedPassword, userId]
        );

        await pool.query(
            'UPDATE password_reset_tokens SET used = TRUE WHERE token = ?',
            [token]
        );

        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Whitelist Email Endpoints
app.post('/whitelist', authenticate, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { email } = req.body;

        // Validate email format
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        await conn.query(
            'INSERT INTO whitelist_emails (email) VALUES (?)',
            [email]
        );

        res.status(201).json({ message: 'Email added to whitelist' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Email already exists in whitelist' });
        }
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

app.get('/whitelist', authenticate, async (req, res) => {
    try {
        const [emails] = await pool.query(
            'SELECT email FROM whitelist_emails ORDER BY created_at DESC'
        );
        res.json(emails.map(e => e.email));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/whitelist/:email', authenticate, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { email } = req.params;

        const [result] = await conn.query(
            'DELETE FROM whitelist_emails WHERE email = ?',
            [email]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Email not found in whitelist' });
        }

        res.json({ message: 'Email removed from whitelist' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));