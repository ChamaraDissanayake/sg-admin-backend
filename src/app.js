require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./config/db');
const routes = require('./routes/index');
const errorHandler = require('./middleware/error');
const path = require('path');

const app = express();

// Initialize database
initDB().then(() => {
    // Middleware
    app.use(cors());
    app.use(express.json());

    // Routes
    app.use('/api', routes);

    // Error handling
    app.use(errorHandler);

    // View images
    app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

    // Start server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});

module.exports = app;