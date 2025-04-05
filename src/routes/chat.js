const express = require('express');
const { processChatMessage, getChatHistory } = require('../controllers/chat');
const router = express.Router();

router.post('/', processChatMessage);
router.get('/history', getChatHistory);

module.exports = router;