// server.js
// This file serves as both the Node.js Express backend for the Stremio Addon
// and hosts the React-based configuration frontend.

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch'); // Required for Node.js versions < 18, or if you prefer node-fetch
const crypto = require('crypto'); // Node.js built-in module for generating random data

// --- Firebase Admin SDK Imports and Initialization ---
// These are necessary for the backend to interact with Firestore for persistent storage.
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

// Global variables provided by the Canvas environment for Firebase configuration
// These must be handled carefully as they might be undefined in local development.
const firebaseConfig = JSON.parse(process.env.__firebase_config || '{}');
const appId = process.env.__app_id || 'default-app-id'; // Use __app_id for unique collection paths

// Initialize Firebase Admin SDK (must be done only once on server startup)
// Use a try-catch block to handle cases where the Firebase config might be missing
// or invalid, especially during local development without a full Canvas environment.
let db;
try {
    if (Object.keys(firebaseConfig).length > 0 && firebaseConfig.projectId) {
        admin.initializeApp({
            credential: admin.credential.cert(firebaseConfig)
        });
        db = getFirestore();
        console.log("Firebase Admin SDK initialized successfully.");
    } else {
        console.warn("Firebase Admin SDK not initialized: Missing or invalid __firebase_config. Firestore operations will be skipped.");
    }
} catch (error) {
    console.error("Firebase Admin SDK initialization failed:", error);
    // If Firebase Admin initialization fails, db will remain undefined, and Firestore operations will be skipped.
}

// IMPORTANT SECURITY NOTE FOR PRODUCTION:
// Sensitive data like Trakt refresh tokens MUST be stored securely in a persistent database
// (e.g., Firestore with Firebase Admin SDK). Storing them in-memory (userTraktTokens) will lead to data loss
// whenever the server restarts, and is not suitable for multiple concurrent users.
// The `tempTraktAuthData` is for temporary session management only.
// For a full-fledged application, you would also need a robust user authentication system
// to associate Stremio users with their Trakt tokens and viewing history persisted in Firestore.


// --- Global API Key Storage (will be populated from Firestore or env as fallback) ---
// These keys will be dynamically loaded and used by the addon's core logic.
let currentApiKeys = {
    traktClientId: process.env.TRAKT_CLIENT_ID || null,
    traktClientSecret: process.env.TRAKT_CLIENT_SECRET || null,
    geminiApiKey: process.env.GEMINI_API_KEY || null
};

// Define a consistent "user ID" for storing the addon's global configuration in Firestore.
// This allows a single deployed instance of the addon to persist its configuration.
const ADDON_CONFIG_USER_ID = 'global_addon_config';

/**
 * Fetches API keys from Firestore and updates the in-memory `currentApiKeys`.
 * Fallback to environment variables if Firestore is unavailable or keys not found.
 */
async function loadApiKeysFromFirestore() {
    if (!db) {
        console.warn("Firestore instance not available. Cannot load API keys from Firestore. Using environment variables.");
        return;
    }
    try {
        const configDocRef = db.collection('artifacts').doc(appId)
                                .collection('users').doc(ADDON_CONFIG_USER_ID)
                                .collection('addon_config').doc('api_keys');
        const docSnap = await configDocRef.get();

        if (docSnap.exists) {
            const data = docSnap.data();
            currentApiKeys.traktClientId = data.traktClientId || currentApiKeys.traktClientId;
            currentApiKeys.traktClientSecret = data.traktClientSecret || currentApiKeys.traktClientSecret;
            currentApiKeys.geminiApiKey = data.geminiApiKey || currentApiKeys.geminiApiKey;
            console.log("API keys loaded from Firestore.");
        } else {
            console.log("No API keys found in Firestore for this addon instance. Using environment variables as fallback.");
        }
    } catch (error) {
        console.error("Error loading API keys from Firestore:", error);
        console.warn("Falling back to environment variables for API keys.");
    }
}

// Call this function at server startup to load keys
// This will attempt to load keys from Firestore, or use ENV vars if Firestore isn't connected or keys aren't stored yet.
loadApiKeysFromFirestore();


// In-memory storage for Trakt tokens (DEMONSTRATION PURPOSES ONLY!)
// In a real application, this would be a database lookup associated with a user ID.
const userTraktTokens = {}; // Format: { [userId]: { access_token, refresh_token, expires_at } }

// Temporary in-memory storage for Trakt client_secret and client_id during OAuth flow.
// This is necessary because Trakt's callback only provides 'code' and 'state', not client credentials.
const tempTraktAuthData = {}; // Format: { [state]: { clientId, clientSecret } }

// --- Express App Setup ---
const app = express();
const PORT = process.env.PORT || 3000; // Use port from environment variable or default to 3000

// Enable CORS for all routes, essential for Stremio to access the addon.
app.use(cors());
// Parse JSON request bodies
app.use(bodyParser.json());

// Helper function to dynamically get the base URL of the deployed application
// This is crucial for correct redirects on platforms like Render.
function getBaseUrl(req) {
    // Render typically provides 'X-Forwarded-Proto' (http/https) and 'X-Forwarded-Host' (hostname) headers.
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${protocol}://${host}`;
}

// --- Stremio Addon Endpoints ---

// Redirect root path to the /configure page
app.get('/', (req, res) => {
    res.redirect('/configure');
});

/**
 * Serves the Stremio Addon manifest file.
 * This file describes the addon's capabilities to Stremio.
 * Stremio clients will fetch this at /manifest.json.
 */
app.get('/manifest.json', (req, res) => {
    const manifest = {
        "id": "com.gemini.stremio.recommender", // Unique ID for your addon
        "version": "1.0.0", // Current version of your addon
        "name": "Gemini AI Recommender", // Display name in Stremio
        "description": "Stremio addon powered by Google Gemini AI for personalized movie/series recommendations and enhanced search. Integrates with Trakt.tv for viewing history.",
        "logo": "https://developers.google.com/static/images/badges/dev-powered-by-google-light.png", // URL to your addon's logo
        "background": "https://images.unsplash.com/photo-1534790566855-4cb788d389ec?auto=format&fit=crop&q=80&w=1974&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D", // URL to a background image
        "resources": [
            "catalog", // Indicates the addon provides catalogs of content
            "meta"     // Indicates the addon provides detailed metadata for items
        ],
        "types": [
            "movie",   // Types of content supported (movies)
            "series"   // Types of content supported (TV series)
        ],
        "idProperty": "imdb_id", // The common ID property used by Stremio for content
        "catalogs": [
            {
                "type": "movie", // Catalog for movies
                "id": "gemini_movie_recommendations", // Unique ID for this catalog
                "name": "Gemini Movie Recs", // Display name for the movie catalog
                "extraRequired": ["search"], // Stremio will pass 'search' query if user types in search bar
                "extraSupported": ["search"] // Indicates support for search parameter
            },
            {
                "type": "series", // Catalog for TV series
                "id": "gemini_series_recommendations", // Unique ID for this catalog
                "name": "Gemini Series Recs", // Display name for the series catalog
                "extraRequired": ["search"],
                "extraSupported": ["search"]
            }
        ],
        "dontAnnounce": true, // Prevent auto-listing on addons.strem.io (manual install only)
        "config": [] // We use a separate web UI for configuration, so no built-in Stremio config fields
    };
    res.json(manifest);
});

/**
 * Handles requests for content catalogs (lists of movies/series).
 * This endpoint provides recommendations based on Gemini AI.
 * It's called when a user browses the "Gemini Movie Recs" or "Gemini Series Recs" catalog in Stremio.
 */
app.get('/catalog/:type/:id.json', async (req, res) => {
    const { type, id } = req.params; // 'type' is 'movie' or 'series', 'id' is 'gemini_movie_recommendations' etc.
    // 'extra' contains parameters like 'search', 'genre', 'user' (if passed by custom configuration).
    const { search, extra } = req.query;

    // For a real app, 'userId' would be a robust identifier. Here, it's a placeholder.
    // Stremio doesn't directly pass user IDs in catalog requests by default.
    // A robust solution would involve the addon managing user identity.
    const userId = extra?.user || 'anonymous_user'; // Using extra.user if available, otherwise a placeholder.

    console.log(`Catalog request: Type=${type}, Catalog ID=${id}, Search Query=${search || 'N/A'}, User ID=${userId}`);

    let prompt = "";
    let recommendedMetas = [];

    // Ensure API keys are loaded (though `loadApiKeysFromFirestore` runs on startup, this provides a safety)
    await loadApiKeysFromFirestore();

    // Check for Gemini API key before proceeding with AI calls
    if (!currentApiKeys.geminiApiKey) {
        console.error("Gemini API key is not available. Cannot generate recommendations.");
        return res.json({ metas: [{
            id: `tt_no_gemini_key`,
            type: type,
            name: `Gemini API Key Missing`,
            poster: `https://placehold.co/200x300/dc2626/FFFFFF?text=Error`,
            posterShape: "regular",
            description: "The Google Gemini API key is not configured. Please visit the addon's configuration page.",
            genres: ["Error"]
        }] });
    }

    // Initialize Gemini AI model with the current API key
    const genAIForThisCall = new GoogleGenerativeAI(currentApiKeys.geminiApiKey);
    const modelForThisCall = genAIForThisCall.getGenerativeModel({ model: "gemini-pro" });


    // --- Trakt History & Gemini Prompt Generation Logic ---
    // In a production app, this is where you would:
    // 1. Check if the user has authenticated with Trakt and if their tokens are valid/present in your database.
    // 2. If so, retrieve their Trakt viewing history (e.g., top watched movies/series).
    //    You might need to refresh their Trakt access token first if it's expired.
    // 3. Construct a sophisticated prompt for Gemini based on this history.
    //    Example prompt: "Based on my watch history of [Movie A, Series B, Movie C], suggest 5 new ${type}s that are similar in genre or theme, or from the same production studios. Provide only the titles, one per line, and ensure they are distinct."
    // 4. If no Trakt history or user not linked, use a general prompt.

    // If Trakt tokens are present (from a successful OAuth flow for this addon instance)
    if (userTraktTokens[userId] && userTraktTokens[userId].access_token) {
        // Here, you'd ideally try to refresh the token if expired using currentApiKeys.traktClientId/Secret.
        // For simplicity in this demo, we assume the token is valid if present.
        console.log(`Using conceptual Trakt tokens for user ${userId}.`);
        prompt = `Based on a user's potential watch history, suggest 5 highly-rated ${type}s from diverse genres. Provide only the titles, one per line.`;
    } else if (search) {
        // If a search query is provided by Stremio
        prompt = `Find 5 ${type}s related to "${search}". Focus on popular or critically acclaimed titles. Provide only the titles, one per line.`;
    } else {
        // Default recommendations if no specific input
        prompt = `Suggest 5 highly-rated ${type}s trending now. Provide only titles, one per line.`;
    }

    try {
        const result = await modelForThisCall.generateContent(prompt); // Use the dynamically initialized model
        const response = await result.response;
        const text = response.text();
        console.log("Gemini Raw Response:", text);

        // Parse the titles from Gemini's text response.
        const titles = text.split('\n')
                           .map(line => line.replace(/^[*-]?\s*/, '').trim())
                           .filter(line => line.length > 0 && line.toLowerCase() !== 'no recommendations found.');

        // --- Metadata Enrichment (Crucial Next Step for a Real Addon) ---
        recommendedMetas = titles.map((title, index) => ({
            id: `tt${Math.floor(Math.random() * 10000000) + 1000000}`,
            type: type,
            name: title,
            poster: `https://placehold.co/200x300/1e293b/a8dadc?text=${encodeURIComponent(title.substring(0, Math.min(title.length, 15)))}`,
            posterShape: "regular"
        }));

    } catch (error) {
        console.error("Error calling Gemini AI for recommendations:", error);
        recommendedMetas = [{
            id: `tt_error_rec`,
            type: type,
            name: `Failed to get recommendations`,
            poster: `https://placehold.co/200x300/dc2626/FFFFFF?text=Error`,
            posterShape: "regular",
            description: `Could not fetch recommendations. Error: ${error.message || 'Unknown error'}. Please check your Gemini API key and backend logs.`,
            genres: ["Error"]
        }];
    }

    res.json({ metas: recommendedMetas });
});

/**
 * Handles requests for detailed metadata about a specific item (movie/series).
 */
app.get('/meta/:type/:imdb_id.json', async (req, res) => {
    const { type, imdb_id } = req.params;
    console.log(`Meta request: Type=${type}, IMDb ID=${imdb_id}`);

    const mockMeta = {
        id: imdb_id,
        type: type,
        name: `Dynamic ${type === 'movie' ? 'Film' : 'Show'} - ${imdb_id}`,
        poster: `https://placehold.co/200x300/475569/a8dadc?text=Poster`,
        background: `https://placehold.co/1000x500/64748b/a8dadc?text=Background`,
        description: `This is a detailed description for the item with ID ${imdb_id}. ` +
                     `This metadata would typically be fetched from a movie database (like TMDb) based on the IMDb ID. ` +
                     `Gemini AI primarily provides textual recommendations and search insights, not direct media metadata.`,
        releaseInfo: "2024",
        genres: ["AI-Generated Pick", "Futuristic", "Interactive", "Drama"],
        director: ["AI Visionary"],
        cast: ["Digital Actor 1", "Digital Actor 2", "Virtual Persona 3"],
        imdbRating: "8.5",
        runtime: "150 min",
        trailer: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    };

    res.json({ meta: mockMeta });
});

// --- Trakt.tv OAuth Endpoints (Backend Logic) ---

/**
 * Endpoint to save API keys to Firestore from the frontend.
 * These keys will then be used by the addon's logic.
 */
app.post('/save-config', async (req, res) => {
    const { traktClientId, traktClientSecret, geminiApiKey } = req.body;

    if (!db) {
        return res.status(500).json({ error: "Firestore is not initialized. Cannot save API keys persistently." });
    }
    if (!traktClientId || !traktClientSecret || !geminiApiKey) {
        return res.status(400).json({ error: "All API keys are required." });
    }

    try {
        const configDocRef = db.collection('artifacts').doc(appId)
                                .collection('users').doc(ADDON_CONFIG_USER_ID)
                                .collection('addon_config').doc('api_keys');
        await configDocRef.set({
            traktClientId,
            traktClientSecret,
            geminiApiKey,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp() // Timestamp for when it was last saved
        }, { merge: true }); // Use merge: true to avoid overwriting other fields if they exist

        // Update in-memory keys for immediate use in this running instance
        currentApiKeys.traktClientId = traktClientId;
        currentApiKeys.traktClientSecret = traktClientSecret;
        currentApiKeys.geminiApiKey = geminiApiKey;

        console.log("API keys saved to Firestore and updated in-memory.");
        res.json({ success: true, message: "API keys saved successfully!" });
    } catch (error) {
        console.error("Error saving API keys to Firestore:", error);
        res.status(500).json({ error: "Failed to save API keys." });
    }
});


/**
 * Endpoint initiated by the frontend to start the Trakt.tv OAuth flow.
 * It uses the client_id and client_secret received from the frontend for this specific auth initiation.
 */
app.post('/trakt-auth-initiate', (req, res) => {
    const { traktClientId, traktClientSecret } = req.body; // Get client ID and secret from the request body

    if (!traktClientId || !traktClientSecret) {
        return res.status(400).json({ error: "Trakt Client ID and Secret are required for authorization." });
    }

    const redirectUri = `${getBaseUrl(req)}/trakt-callback`;
    const state = crypto.randomUUID(); // Generate a unique state to link callback request

    // Store the client ID and secret temporarily, associated with the state
    tempTraktAuthData[state] = { clientId: traktClientId, clientSecret: traktClientSecret };
    console.log(`Stored temporary Trakt auth data for state: ${state}`);

    const authUrl = `https://trakt.tv/oauth/authorize?response_type=code&client_id=${traktClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    res.json({ authUrl });
});

/**
 * Callback endpoint for Trakt.tv OAuth.
 * Trakt.tv redirects the user's browser back to this URL after authorization,
 * providing an authorization 'code' and 'state' in the URL query parameters.
 * This endpoint uses the 'state' to retrieve the temporarily stored client credentials
 * and exchanges the 'code' for access and refresh tokens.
 */
app.get('/trakt-callback', async (req, res) => {
    const code = req.query.code; // The authorization code from Trakt
    const state = req.query.state; // The state parameter to retrieve stored client credentials
    const redirectUri = `${getBaseUrl(req)}/trakt-callback`; // Must exactly match the URI registered with Trakt.tv

    if (!code || !state) {
        console.error("Trakt callback: Missing authorization code or state.");
        return res.redirect('/configure?error=trakt_no_code_or_state');
    }

    const { clientId, clientSecret } = tempTraktAuthData[state] || {};

    // Remove the temporary data immediately after retrieval for security
    delete tempTraktAuthData[state];

    if (!clientId || !clientSecret) {
        console.error(`Trakt API Client ID or Client Secret not found for state ${state}. Session expired or invalid state.`);
        return res.redirect('/configure?error=trakt_session_expired');
    }

    try {
        // Exchange the authorization code for access and refresh tokens
        const response = await fetch('https://api.trakt.tv/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                code: code,
                client_id: clientId, // Use the client ID retrieved from temp storage
                client_secret: clientSecret, // Use the client secret retrieved from temp storage
                redirect_uri: redirectUri,
                grant_type: 'authorization_code' // Specifies the OAuth grant type
            })
        });

        const data = await response.json();

        if (response.ok) {
            const { access_token, refresh_token, expires_in, created_at } = data;
            // For this demo, we use a fixed user ID. In a real system, you'd map this
            // to a unique Stremio user or generate a persistent ID for the user.
            const userId = 'stremio_trakt_user_123'; // Example user ID

            // Store tokens in in-memory object (DEMO ONLY!)
            userTraktTokens[userId] = {
                access_token,
                refresh_token,
                expires_at: created_at + expires_in // Calculate expiration timestamp
            };
            console.log("Trakt tokens received and stored (in-memory for demo). Access token will expire in:", expires_in, "seconds.");

            // --- Conceptual Firestore Integration for Server-Side Storage of Trakt Tokens ---
            // If Firestore is initialized, persist the Trakt tokens.
            if (db) {
                try {
                    const traktTokenDocRef = db.collection('artifacts').doc(appId)
                                               .collection('users').doc(ADDON_CONFIG_USER_ID) // Link to the global config user
                                               .collection('trakt_tokens').doc(userId); // Use a sub-collection for user-specific Trakt tokens
                    await traktTokenDocRef.set({
                        access_token: access_token,
                        refresh_token: refresh_token,
                        expires_at: expires_in, // Store expires_in directly from Trakt response
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                    console.log(`Trakt tokens successfully stored in Firestore for user ${userId}.`);
                } catch (firestoreError) {
                    console.error("Error saving Trakt tokens to Firestore:", firestoreError);
                }
            }
            // --- End Firestore Conceptual ---

            // Redirect back to the configuration page with success message and addon URL
            res.redirect(`/configure?trakt_auth_success=true&addonUrl=${encodeURIComponent(`${getBaseUrl(req)}/manifest.json`)}`);
        } else {
            // Log Trakt API error and redirect with error message
            console.error("Error exchanging Trakt code for tokens:", data);
            res.redirect(`/configure?error=trakt_token_exchange_failed&details=${encodeURIComponent(data.error_description || data.error || 'Unknown error')}`);
        }
    } catch (error) {
        // Log network or parsing errors during the token exchange
        console.error("Network or parsing error during Trakt token exchange:", error);
        res.redirect('/configure?error=network_error');
    }
});

/**
 * Function to refresh an expired Trakt access token using the refresh token.
 * This would be called internally by your backend logic before making Trakt API calls
 * if the current access token is found to be expired.
 */
async function refreshTraktToken(userId) {
    const tokens = userTraktTokens[userId]; // Get current in-memory tokens for the user
    if (!tokens || !tokens.refresh_token) {
        console.warn(`No refresh token found for user ${userId}. Cannot refresh.`);
        return false;
    }

    // Check if the current access token is still valid (using the original expires_in from Trakt)
    // Note: 'expires_at' was created_at + expires_in.
    // To properly check, you'd need the 'created_at' from the original token response, or recalculate.
    // For simplicity, this example just checks for presence. In a real app, track `created_at` or fetch from DB.
    // A proper check would involve fetching the latest token data from Firestore and comparing timestamps.
    console.log(`Refreshing Trakt token for user ${userId}...`);

    // Ensure API keys are loaded before attempting to refresh
    await loadApiKeysFromFirestore();

    if (!currentApiKeys.traktClientId || !currentApiKeys.traktClientSecret) {
        console.error("Trakt Client ID or Secret is not available in currentApiKeys. Cannot refresh Trakt token.");
        return false;
    }

    try {
        const response = await fetch('https://api.trakt.tv/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                refresh_token: tokens.refresh_token,
                client_id: currentApiKeys.traktClientId, // Use dynamically loaded key
                client_secret: currentApiKeys.traktClientSecret, // Use dynamically loaded key
                grant_type: 'refresh_token' // Specifies the OAuth grant type for refresh
            })
        });

        const data = await response.json();

        if (response.ok) {
            const { access_token, refresh_token, expires_in, created_at } = data;
            // Update the stored tokens in-memory
            userTraktTokens[userId] = {
                access_token,
                refresh_token,
                expires_at: created_at + expires_in
            };
            console.log(`Trakt token refreshed for user ${userId}. New expiration: ${new Date(userTraktTokens[userId].expires_at * 1000)}`);

            // --- Conceptual Firestore Integration for Token Update ---
            if (db) {
                try {
                    const traktTokenDocRef = db.collection('artifacts').doc(appId)
                                               .collection('users').doc(ADDON_CONFIG_USER_ID)
                                               .collection('trakt_tokens').doc(userId);
                    await traktTokenDocRef.update({
                        access_token: access_token,
                        refresh_token: refresh_token,
                        expires_at: expires_in, // Store expires_in directly from Trakt response
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log(`Trakt tokens updated in Firestore for user ${userId}.`);
                } catch (firestoreError) {
                    console.error("Error updating Trakt tokens in Firestore:", firestoreError);
                }
            }
            // --- End Firestore Conceptual ---

            return true;
        } else {
            console.error(`Error refreshing Trakt token for user ${userId}:`, data);
            // Handle specific refresh token errors (e.g., token revoked)
            return false;
        }
    } catch (error) {
        console.error(`Network error during Trakt token refresh for user ${userId}:`, error);
        return false;
    }
}

// --- Web Configuration Frontend (React embedded directly in HTML) ---
// This endpoint serves the single HTML file that contains the React application
// for configuring the addon. React is loaded via CDN for simplicity in this single-file setup.
app.get('/configure', (req, res) => {
    // These variables (__firebase_config, __initial_auth_token) are provided by the Canvas environment.
    // They are used here to initialize Firebase client-side SDK for general user identity,
    // NOT for storing sensitive Trakt tokens, which are handled server-side.
    const firebaseConfigJson = typeof __firebase_config !== 'undefined' ? JSON.stringify(JSON.parse(__firebase_config)) : '{}';
    const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? `'${__initial_auth_token}'` : 'undefined';

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Stremio Gemini Addon Configuration</title>
            <!-- Load React and ReactDOM from CDN -->
            <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
            <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
            <!-- Load Babel for JSX transformation in the browser -->
            <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
            <!-- Load Tailwind CSS from CDN -->
            <script src="https://cdn.tailwindcss.com"></script>
            <!-- Load Inter font from Google Fonts -->
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
            <style>
                /* Custom styles for the configuration page, enhancing Tailwind defaults */
                body {
                    font-family: 'Inter', sans-serif;
                    background-color: #0f172a; /* Tailwind slate-900 */
                    color: #e2e8f0; /* Tailwind slate-200 */
                }
                .container {
                    max-width: 800px;
                }
                /* Styling for input fields */
                input[type="text"], input[type="password"] {
                    background-color: #1e293b; /* Tailwind slate-800 */
                    border: 1px solid #475569; /* Tailwind slate-600 */
                    color: #e2e8f0;
                    padding: 0.5rem 0.75rem;
                    border-radius: 0.375rem; /* rounded-md */
                    width: 100%;
                    transition: all 0.2s ease-in-out;
                }
                input[type="text"]:focus, input[type="password"]:focus {
                    outline: none;
                    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.5); /* blue-500 ring */
                }
                /* Styling for buttons */
                button {
                    background-color: #3b82f6; /* Tailwind blue-500 */
                    color: white;
                    padding: 0.625rem 1rem;
                    border-radius: 0.375rem; /* rounded-md */
                    font-weight: 600; /* font-semibold */
                    transition: all 0.3s ease-in-out;
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); /* shadow-lg */
                }
                button:hover {
                    background-color: #2563eb; /* Tailwind blue-600 */
                    transform: scale(1.02);
                }
                /* Styling for message boxes (success, error, info) */
                .message-box {
                    padding: 1rem;
                    border-radius: 0.5rem;
                    width: 100%;
                    max-width: 40rem; /* Max width for consistency */
                    text-align: center;
                    font-weight: 500;
                }
                .success {
                    background-color: #16a34a; /* green-600 */
                    color: white;
                }
                .error {
                    background-color: #dc2626; /* red-600 */
                    color: white;
                }
                .info {
                    background-color: #3b82f6; /* blue-500 */
                    color: white;
                }
            </style>
            <!-- Firebase SDKs for client-side functionality -->
            <script type="module">
                // Import necessary Firebase modules from CDN
                import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
                import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
                import { getFirestore, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

                // Initialize Firebase App with config provided by the environment
                const firebaseConfig = ${firebaseConfigJson};
                window.firebaseApp = initializeApp(firebaseConfig);
                window.firebaseAuth = getAuth(window.firebaseApp);
                window.firebaseDb = getFirestore(window.firebaseApp);

                // Authenticate Firebase user
                async function authenticateFirebase() {
                    try {
                        const token = ${initialAuthToken};
                        if (token && token !== 'undefined') { // Check if token is actually provided
                            await signInWithCustomToken(window.firebaseAuth, token);
                            console.log('Firebase: Signed in with custom token.');
                        } else {
                            await signInAnonymously(window.firebaseAuth);
                            console.log('Firebase: Signed in anonymously.');
                        }
                    } catch (error) {
                        console.error('Firebase authentication error:', error);
                    }
                }

                authenticateFirebase(); // Call authentication on page load

                // Listen for Firebase auth state changes to get current user ID
                onAuthStateChanged(window.firebaseAuth, (user) => {
                    if (user) {
                        window.currentUserId = user.uid; // Make user ID available globally
                        console.log('Firebase: Current User ID:', window.currentUserId);
                        // This userId can be used for client-side analytics or preference storage
                        // but not for storing sensitive Trakt tokens (which are server-side).
                    } else {
                        window.currentUserId = null;
                        console.log('Firebase: No user signed in.');
                    }
                });
            </script>
        </head>
        <body class="p-6">
            <div id="root" class="container mx-auto p-6 bg-slate-800 rounded-lg shadow-xl mt-10"></div>

            <script type="text/babel">
                const { useState, useEffect } = React;
                const { createRoot } = ReactDOM;

                function App() {
                    // State variables for API keys and messages
                    const [traktClientId, setTraktClientId] = useState('');
                    const [traktClientSecret, setTraktClientSecret] = useState('');
                    const [geminiApiKey, setGeminiApiKey] = useState('');
                    const [addonUrl, setAddonUrl] = useState('');
                    const [message, setMessage] = useState('');
                    const [error, setError] = useState('');

                    // Effect hook to run once on component mount for initial setup and URL parameter parsing
                    useEffect(() => {
                        // Parse URL parameters for post-Trakt authentication messages
                        const params = new URLSearchParams(window.location.search);
                        if (params.get('trakt_auth_success')) {
                            setMessage('Trakt.tv authentication successful! Your addon is ready.');
                            setAddonUrl(params.get('addonUrl'));
                            // Clean up URL parameters after processing
                            window.history.replaceState({}, document.title, window.location.pathname);
                        } else if (params.get('error')) {
                            setError('Error during Trakt.tv authentication: ' + params.get('error') + '. Details: ' + (params.get('details') || 'No additional details.'));
                            window.history.replaceState({}, document.title, window.location.pathname);
                        }

                        // Load saved keys from backend if available (conceptual for a refresh or new session)
                        // In a production app, you might fetch initial config from backend if it's saved.
                        // For this demo, keys are entered fresh or picked up from a new /save-config call.
                    }, []);

                    // Handler for saving all API keys to the backend (which persists them to Firestore)
                    const handleSaveKeys = async () => {
                        if (!traktClientId || !traktClientSecret || !geminiApiKey) {
                            setError('All API key fields must be filled to save.');
                            return;
                        }
                        setError('');
                        setMessage('Saving API keys...');
                        try {
                            const response = await fetch('/save-config', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ traktClientId, traktClientSecret, geminiApiKey })
                            });
                            const data = await response.json();
                            if (response.ok && data.success) {
                                setMessage('API keys saved successfully for this addon instance! You can now authorize Trakt.tv.');
                            } else {
                                setError('Failed to save API keys: ' + (data.error || 'Unknown error.'));
                            }
                        } catch (err) {
                            setError('Network error while saving keys: ' + err.message);
                        }
                    };

                    // Handler for initiating Trakt authentication
                    const handleTraktAuth = async () => {
                        // Ensure keys are set before attempting Trakt auth
                        if (!traktClientId || !traktClientSecret) {
                            setError('Please enter both Trakt Client ID and Secret before authorizing.');
                            return;
                        }
                        setError('');
                        setMessage('Initiating Trakt.tv authorization...');
                        try {
                            // Call backend endpoint to get the Trakt authorization URL, passing client credentials
                            const response = await fetch('/trakt-auth-initiate', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    traktClientId,
                                    traktClientSecret // These are sent to the backend for the immediate OAuth flow
                                })
                            });
                            const data = await response.json();
                            if (response.ok && data.authUrl) {
                                // Redirect user to Trakt.tv for authorization
                                window.location.href = data.authUrl;
                            } else {
                                setError('Failed to get Trakt authorization URL from backend. ' + (data.error || ''));
                            }
                        } catch (err) {
                            setError('Network error or backend issue during Trakt initiation: ' + err.message);
                        }
                    };

                    // Handler for copying the addon URL to clipboard
                    const handleCopyUrl = () => {
                        const textarea = document.createElement('textarea');
                        textarea.value = addonUrl;
                        textarea.style.position = 'absolute';
                        textarea.style.left = '-9999px';
                        document.body.appendChild(textarea);
                        textarea.select();
                        try {
                            document.execCommand('copy');
                            setMessage('Addon URL copied to clipboard!');
                        } catch (err) {
                            setError('Failed to copy URL. Please copy it manually from the text field.');
                            console.error('Failed to copy text:', err);
                        } finally {
                            document.body.removeChild(textarea);
                        }
                    };

                    return (
                        <div className="flex flex-col items-center p-8 space-y-6">
                            <h1 className="text-4xl font-bold text-blue-400 mb-6 text-center">Stremio Gemini Addon Configuration</h1>

                            <p className="text-lg text-slate-300 text-center mb-4">
                                This addon uses Google Gemini AI for personalized movie and series recommendations and to enhance search capabilities,
                                leveraging your viewing habits from Trakt.tv.
                            </p>

                            <div className="w-full max-w-md bg-slate-700 p-6 rounded-lg shadow-md space-y-4">
                                <h2 className="text-2xl font-semibold text-white mb-4">API Key Configuration</h2>
                                <p className="text-slate-400 text-sm">
                                    Input your API keys below. For persistent functionality after deployment on Render,
                                    you *can* also set these as environment variables in your Render service, but
                                    this UI provides a way to configure them directly for your addon instance.
                                </p>

                                {/* Input field for Trakt Client ID */}
                                <div>
                                    <label htmlFor="traktClientId" className="block text-slate-300 text-sm font-bold mb-2 mt-4">
                                        Trakt Client ID:
                                    </label>
                                    <input
                                        type="text"
                                        id="traktClientId"
                                        className="shadow appearance-none border rounded w-full py-2 px-3 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        value={traktClientId}
                                        onChange={(e) => setTraktClientId(e.target.value)}
                                        placeholder="Enter your Trakt Client ID"
                                    />
                                </div>
                                {/* Input field for Trakt Client Secret */}
                                <div>
                                    <label htmlFor="traktClientSecret" className="block text-slate-300 text-sm font-bold mb-2 mt-4">
                                        Trakt Client Secret:
                                    </label>
                                    <input
                                        type="password"
                                        id="traktClientSecret"
                                        className="shadow appearance-none border rounded w-full py-2 px-3 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        value={traktClientSecret}
                                        onChange={(e) => setTraktClientSecret(e.target.value)}
                                        placeholder="Enter your Trakt Client Secret"
                                    />
                                </div>
                                {/* Input field for Gemini API Key */}
                                <div>
                                    <label htmlFor="geminiApiKey" className="block text-slate-300 text-sm font-bold mb-2 mt-4">
                                        Google Gemini API Key:
                                    </label>
                                    <input
                                        type="password"
                                        id="geminiApiKey"
                                        className="shadow appearance-none border rounded w-full py-2 px-3 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        value={geminiApiKey}
                                        onChange={(e) => setGeminiApiKey(e.target.value)}
                                        placeholder="Enter your Google Gemini API Key"
                                    />
                                </div>
                                {/* Button to save all API keys */}
                                <button
                                    onClick={handleSaveKeys}
                                    className="w-full py-2 px-4 rounded-md font-semibold shadow-lg transition duration-300 ease-in-out transform hover:scale-105"
                                >
                                    Save All API Keys
                                </button>
                                <p className="text-sm text-slate-400 mt-2">
                                    After saving, these keys will be stored persistently for this addon instance.
                                </p>
                            </div>

                            <div className="w-full max-w-md bg-slate-700 p-6 rounded-lg shadow-md space-y-4">
                                <h2 className="text-2xl font-semibold text-white mb-4">Trakt.tv Authorization</h2>
                                <p className="text-slate-400 text-sm">
                                    To integrate with Trakt.tv, you need to register a new application on
                                    <a href="https://trakt.tv/oauth/applications" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline ml-1 mr-1">Trakt.tv/oauth/applications</a>.
                                    <br/><br/>
                                    <strong>Crucially, set the <code className="bg-slate-800 p-1 rounded">Redirect URI</code> for your Trakt application to:</strong>
                                    <br />
                                    <code className="bg-slate-800 p-1 rounded block mt-2 break-all text-sm">
                                        &lt;YOUR_RENDER_APP_URL&gt;/trakt-callback
                                    </code>
                                    <br/>
                                    For example, if your Render app URL is <code className="bg-slate-800 p-1 rounded break-all text-sm">https://my-gemini-stremio-addon.onrender.com</code>,
                                    your Redirect URI on Trakt would be <code className="bg-slate-800 p-1 rounded break-all text-sm">https://my-gemini-stremio-addon.onrender.com/trakt-callback</code>.
                                </p>
                                {/* Button to initiate Trakt authorization */}
                                <button
                                    onClick={handleTraktAuth}
                                    className="w-full py-2 px-4 rounded-md font-semibold shadow-lg transition duration-300 ease-in-out transform hover:scale-105"
                                >
                                    Authorize with Trakt.tv
                                </button>
                                <p className="text-sm text-red-400 mt-2">
                                    **Note:** You must have saved your Trakt Client ID and Secret using the "Save All API Keys" button above before authorizing.
                                </p>
                            </div>

                            {/* Conditional rendering for success and error messages */}
                            {message && (
                                <div className="message-box success">
                                    {message}
                                </div>
                            )}

                            {error && (
                                <div className="message-box error">
                                    {error}
                                </div>
                            )}

                            {/* Conditional rendering for the addon URL after successful authentication */}
                            {addonUrl && (
                                <div className="w-full max-w-md bg-slate-700 p-6 rounded-lg shadow-md space-y-4">
                                    <h2 className="text-2xl font-semibold text-white mb-4">Your Stremio Addon URL</h2>
                                    <p className="text-slate-300 break-words">
                                        Copy this URL and paste it into Stremio's addon search bar to install:
                                        <br />
                                        <code className="bg-slate-800 p-2 rounded block mt-2 text-blue-300 select-all">
                                            {addonUrl}
                                        </code>
                                    </p>
                                    {/* Button to copy the URL */}
                                    <button
                                        onClick={handleCopyUrl}
                                        className="w-full py-2 px-4 rounded-md font-semibold shadow-lg transition duration-300 ease-in-out transform hover:scale-105"
                                    >
                                        Copy Addon URL
                                    </button>
                                    <p className="text-sm text-slate-400 mt-2">
                                        After installing, look for "Gemini Movie Recs" and "Gemini Series Recs" in your Stremio Discover section.
                                        Remember, this addon provides recommendations and enhanced search results, but it does not provide actual streaming links.
                                    </p>
                                </div>
                            )}

                            <p className="text-sm text-slate-500 mt-6 text-center">
                                Powered by Google Gemini AI & Trakt.tv
                            </p>
                        </div>
                    );
                }

                // Ensure the DOM is fully loaded before attempting to render the React app
                document.addEventListener('DOMContentLoaded', () => {
                    const container = document.getElementById('root');
                    if (container) {
                        const root = createRoot(container);
                        root.render(<App />);
                    } else {
                        console.error("Error: Root element not found! Cannot render React app.");
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// --- Start the Express Server ---
app.listen(PORT, () => {
    console.log(`Stremio Gemini Addon server running on port ${PORT}`);
    console.log(`Access configuration at http://localhost:${PORT}/configure`);
    console.log(`Addon manifest at http://localhost:${PORT}/manifest.json`);
});
