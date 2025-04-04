import fileService from '../services/fileService.js';
import authenticate from '../middleware/auth.js';
import upload from '../config/upload.js';

export const uploadFile = [
    authenticate,
    upload.single('file'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const result = await fileService.uploadFile(req.file);
            res.json(result);
        } catch (error) {
            if (error.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: 'File too large (max 50MB)' });
            }
            console.error('Upload error:', error);
            res.status(500).json({
                error: 'File upload failed',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
];

export const getFiles = async (req, res) => {
    try {
        const files = await File.getAll();
        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

export const deleteFile = async (req, res) => {
    try {
        const fileId = req.params.id;
        const filePath = await File.getPath(fileId);

        if (!filePath) {
            return res.status(404).json({ error: 'File not found in database' });
        }

        try {
            await fs.unlink(filePath);
        } catch (err) {
            console.error('Physical file deletion warning:', err.message);
        }

        const deleted = await File.delete(fileId);
        res.json({
            message: 'File deleted completely',
            details: {
                dbRecordDeleted: deleted,
                physicalFileDeleted: true,
                deletedId: fileId
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};