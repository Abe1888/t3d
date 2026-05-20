import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import apiRouter from './routes/api';
import { GeminiLiveService } from './services/GeminiLiveService';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Common middleware
app.use(express.json());

// API Routes
app.use('/api', apiRouter);

// Serve static assets in production
if (isProduction) {
  const distPath = path.resolve(process.cwd(), 'dist');
  console.log(`[Server] Production mode: Serving static files from ${distPath}`);
  
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    
    // SPA fallback: redirect all unhandled requests to index.html (Express 5 wildcard syntax)
    app.get('*any', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    console.warn(`[Server] Warning: 'dist' folder not found at ${distPath}. Run 'npm run build' first.`);
    app.get('*any', (req, res) => {
      res.status(404).send('Static frontend assets not compiled. Please run npm run build.');
    });
  }
} else {
  console.log('[Server] Development mode: API/WebSocket server running alongside Vite dev server.');
  app.get('/', (req, res) => {
    res.send('API/WebSocket server running in development mode. Use Vite on port 3001.');
  });
}

// Create HTTP server
const httpServer = createServer(app);

// Initialize WebSocket Server
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade manually
httpServer.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/ws/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  } catch (err) {
    console.error('[Server] Upgrade processing error:', err);
    socket.destroy();
  }
});

const apiKey = process.env.GEMINI_API_KEY || '';
if (!apiKey) {
  console.error('[Server] CRITICAL: GEMINI_API_KEY is not defined in the environment variables!');
}

const service = new GeminiLiveService(apiKey);

// WebSocket connection lifecycle handler
wss.on('connection', async (clientWs, request) => {
  console.log('[Server] Client connected to WebSocket');

  let lang = 'en';
  let welcome = true;
  try {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    const rawLang = url.searchParams.get('lang') || 'en';
    lang = rawLang.toLowerCase();
    if (lang !== 'en' && lang !== 'am' && lang !== 'ar') {
      lang = 'en';
    }
    const rawWelcome = url.searchParams.get('welcome');
    if (rawWelcome === 'false') {
      welcome = false;
    }
  } catch (e) {
    console.error('[Server] Error parsing connection request URL lang param:', e);
  }

  let selectedVoice = 'Zephyr';
  try {
    const configPath = path.resolve(process.cwd(), 'src/translinkconfig/live-voice/voice_config.json');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const voiceConfig = JSON.parse(raw);
      const langConfig = voiceConfig[lang] || voiceConfig['en'];
      if (langConfig) {
        if (langConfig.activeVoice) {
          selectedVoice = langConfig.activeVoice;
        } else if (langConfig.voices) {
          const active = Object.keys(langConfig.voices).find((k) => langConfig.voices[k] === 1);
          if (active) selectedVoice = active;
        }
      }
    }
  } catch (err) {
    console.error('[Server] Error loading voice config:', err);
  }

  try {
    console.log(`[Server] Handing off client to GeminiLiveService (lang: ${lang}, voice: ${selectedVoice}, welcome: ${welcome})`);
    await service.handleConnection(clientWs, lang, selectedVoice, welcome);
  } catch (err) {
    console.error('[Server] GeminiLiveService connection handoff failed:', err);
    clientWs.send(JSON.stringify({ error: 'Failed to initialize AI Service' }));
    clientWs.close();
  }
});

// Start listening
httpServer.listen(PORT, () => {
  console.log(`[Server] Server listening on http://localhost:${PORT}`);
});

// Graceful shutdown handling
const shutdown = () => {
  console.log('[Server] Shutting down server gracefully...');
  
  // Close all websocket clients
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ info: 'Server shutting down' }));
      client.close();
    }
  });

  wss.close(() => {
    console.log('[Server] WebSocket server closed.');
    httpServer.close(() => {
      console.log('[Server] HTTP server closed.');
      process.exit(0);
    });
  });

  // Force close after timeout
  setTimeout(() => {
    console.error('[Server] Force shutting down...');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
