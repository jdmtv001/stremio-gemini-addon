require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

// Read API keys from environment or temporary config
let GEMINI_KEY = process.env.GEMINI_KEY || '';
let TMDB_KEY = process.env.TMDB_KEY || '';
let RPDB_KEY = process.env.RPDB_KEY || '';

// Config routes
app.get('/config', (req, res) => {
    res.sendFile(__dirname + '/public/config.html');
});

app.post('/config', (req, res) => {
    GEMINI_KEY = req.body.geminiKey || GEMINI_KEY;
    TMDB_KEY = req.body.tmdbKey || TMDB_KEY;
    RPDB_KEY = req.body.rpdbKey || RPDB_KEY;
    res.send('<h2>API keys updated!</h2><a href="/config">Go Back</a>');
});

// Test endpoint
app.get('/', (req, res) => res.send('Server running!'));

// Stremio addon manifest
const manifest = {
    id: 'community.stremio.geminiaddon',
    version: '1.0.0',
    name: 'Gemini AI Recommendations',
    description: 'Uses Google Gemini, TMDB, and RPDB to recommend movies and shows.',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    catalogs: [
        { type: 'movie', id: 'gemini_recs', name: 'AI Recommendations (Movies)' },
        { type: 'series', id: 'gemini_recs_series', name: 'AI Recommendations (Series)' }
    ]
};

const builder = new addonBuilder(manifest);

// Catalog handler: Gemini + TMDB
builder.defineCatalogHandler(async ({ type }) => {
    if (!GEMINI_KEY) return { metas: [] };

    // Example user history (can later be dynamic)
    const userHistory = ['Inception', 'The Matrix'];

    // Fetch recommendations from Google Gemini
    let recommendations = [];
    try {
        const res = await fetch('https://gemini.googleapis.com/v1/recommendations', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GEMINI_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt: `Recommend ${type} titles based on: ${userHistory.join(', ')}`,
                max_results: 10
            })
        });
        const data = await res.json();
        recommendations = data.recommendations || [];
    } catch (err) {
        console.error('Gemini API error:', err);
    }

    const metas = [];
    for (let title of recommendations) {
        if (!TMDB_KEY) continue;
        try {
            const tmdbRes = await fetch(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}`);
            const tmdbData = await tmdbRes.json();
            if (tmdbData.results && tmdbData.results.length > 0) {
                const item = tmdbData.results[0];
                metas.push({
                    id: item.id.toString(),
                    type,
                    name: item.title || item.name,
                    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
                    description: item.overview || ''
                });
            }
        } catch (e) {
            console.error('TMDB fetch error:', e);
        }
    }

    return { metas };
});

// Meta handler (optional)
builder.defineMetaHandler(async ({ type, id }) => {
    return {
        meta: {
            id,
            type,
            name: 'Demo Metadata',
            description: 'More info will be shown here once integrated with APIs.'
        }
    };
});

app.get('/manifest.json', (req, res) => res.json(builder.getInterface().manifest));
app.get('/:resource/:type/:id.json', (req, res) => builder.getInterface().get(req, res));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Addon running on port ${PORT}`));