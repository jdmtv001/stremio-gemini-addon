const express = require('express');
const path = require('path');
const app = express();

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// Serve config interface at /configure
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

// Basic Stremio addon route (extend as needed)
app.get('/', (req, res) => {
    res.json({ message: 'Stremio AI Search Addon' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});