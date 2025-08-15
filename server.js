require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

let GEMINI_KEY = process.env.GEMINI_KEY || '';
let TMDB_KEY = process.env.TMDB_KEY || '';
let RPDB_KEY = process.env.RPDB_KEY || '';

app.get('/config', (req, res) => {
    res.sendFile(__dirname + '/public/config.html');
});

app.post('/config', (req, res) => {
    GEMINI_KEY = req.body.geminiKey || GEMINI_KEY;
    TMDB_KEY = req.body.tmdbKey || TMDB_KEY;
    RPDB_KEY = req.body.rpdbKey || RPDB_KEY;
    res.send('<h2>API keys updated!</h2><a href="/config">Go Back</a>');
});

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

builder.defineCatalogHandler(async ({ type, id }) => {
    return {
        metas: [
            { id: 'movie1', type: 'movie', name: 'Demo Movie', poster: 'https://via.placeholder.com/300x450?text=Demo+Movie' }
        ]
    };
});

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

app.get('/manifest.json', (req, res) => {
    res.json(builder.getInterface().manifest);
});

app.get('/:resource/:type/:id.json', (req, res) => {
    builder.getInterface().get(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Addon running on port ${PORT}`);
});
