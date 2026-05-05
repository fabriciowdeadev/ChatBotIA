require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));


// ─── Config ────────────────────────────────────────────────────────────────────
const PANEL_PASSWORD    = process.env.PANEL_PASSWORD || 'lanch102938';
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const MAPS_API_KEY      = process.env.MAPS_API_KEY;
const DELIVERY_ORIGIN   = process.env.DELIVERY_ORIGIN;
const PRICE_PER_KM      = parseFloat(process.env.DELIVERY_PRICE_PER_KM) || 1;
const PORT              = process.env.PORT || 3000;

// ─── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR          = path.join(__dirname, 'data');
const CLIENTS_FILE      = path.join(DATA_DIR, 'clients.json');
const INSTRUCTIONS_FILE = path.join(DATA_DIR, 'instrucoes.txt');
const INSTRUCTIONS_DEFAULT = path.join(__dirname, 'instrucoes.txt');

if (!fs.existsSync(DATA_DIR)) { fs.mkdirSync(DATA_DIR, { recursive: true }); console.log('[Init] Diretorio data/ criado'); }
if (!fs.existsSync(CLIENTS_FILE)) { fs.writeFileSync(CLIENTS_FILE, '{}'); console.log('[Init] clients.json criado'); }
// On first run, copy default instructions into the data volume
if (!fs.existsSync(INSTRUCTIONS_FILE) && fs.existsSync(INSTRUCTIONS_DEFAULT)) {
  fs.copyFileSync(INSTRUCTIONS_DEFAULT, INSTRUCTIONS_FILE);
  console.log('[Init] instrucoes.txt copiado para data/');
} else if (fs.existsSync(INSTRUCTIONS_FILE)) {
  console.log('[Init] instrucoes.txt carregado de data/');
} else {
  console.warn('[Init] AVISO: instrucoes.txt nao encontrado!');
}
console.log('[Config] GEMINI_API_KEY:', GEMINI_API_KEY ? 'OK' : 'NAO DEFINIDA');
console.log('[Config] MAPS_API_KEY:', MAPS_API_KEY ? 'OK' : 'NAO DEFINIDA');
console.log('[Config] DELIVERY_ORIGIN:', DELIVERY_ORIGIN || 'NAO DEFINIDA');
console.log('[Config] PANEL_PASSWORD:', PANEL_PASSWORD ? 'OK' : 'NAO DEFINIDA');

// ─── State ─────────────────────────────────────────────────────────────────────
let waClient    = null;
let botRunning  = false;
let currentQR   = null;
const chatHistory = {}; // { phoneNumber: [{role, parts}] }

// ─── Helpers ───────────────────────────────────────────────────────────────────
const loadClients  = () => { try { return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); } catch { return {}; } };
const saveClients  = (c) => fs.writeFileSync(CLIENTS_FILE, JSON.stringify(c, null, 2));
const getInstructions = () => fs.readFileSync(INSTRUCTIONS_FILE, 'utf8');

// ─── Password middleware ────────────────────────────────────────────────────────
function verifyPassword(req, res, next) {
  const { password } = req.body || {};
  if (password !== PANEL_PASSWORD) return res.status(401).json({ error: 'Senha incorreta' });
  next();
}

// ─── Google Maps frete ─────────────────────────────────────────────────────────
async function calcularFrete(endereco) {
  console.log('[Frete] Calculando para:', endereco);
  try {
    const resp = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
      params: {
        origins:      DELIVERY_ORIGIN,
        destinations: `${endereco}, Dourados, MS, Brasil`,
        key:          MAPS_API_KEY,
        units:        'metric',
      },
    });
    const el = resp.data?.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK') { console.warn('[Frete] Status Maps:', el?.status); return null; }
    const km    = el.distance.value / 1000;
    const frete = 5 + Math.ceil(km) * PRICE_PER_KM;
    console.log('[Frete]', km.toFixed(2) + 'km -> R$', frete.toFixed(2));
    return { frete, km };
  } catch (err) {
    console.error('[Frete] Erro:', err.message);
    return null;
  }
}

// ─── Gemini chat ───────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

async function chatWithGemini(phoneNumber, userMessage) {
  console.log('[Gemini] Mensagem de ' + phoneNumber + ':', userMessage.substring(0, 80));
  const clients    = loadClients();
  const clientName = clients[phoneNumber] || null;
  const instructions = getInstructions();

  const systemPrompt =
    `${instructions}\n\n` +
    `CLIENTE ATUAL: ${clientName ? clientName : 'Novo cliente (nome ainda não informado)'}\n` +
    `Número WhatsApp: ${phoneNumber}\n\n` +
    `=== FUNÇÕES DO SISTEMA ===\n` +
    `Quando o cliente informar o nome, inclua exatamente: [registrarNome:NOME]\n` +
    `Quando precisar calcular o frete, inclua exatamente: [calcularFrete:ENDEREÇO_COMPLETO]\n` +
    `Essas tags serão substituídas automaticamente pelo sistema antes de enviar a mensagem.`;

  if (!chatHistory[phoneNumber]) chatHistory[phoneNumber] = [];

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: systemPrompt,
  });

  const chat = model.startChat({ history: chatHistory[phoneNumber] });
  const result = await chat.sendMessage(userMessage);
  let text = result.response.text();

  // Process [registrarNome:...]
  const nameMatch = text.match(/\[registrarNome:([^\]]+)\]/i);
  if (nameMatch) {
    const nome = nameMatch[1].trim();
    console.log('[Bot] Registrando nome:', nome, '-> ' + phoneNumber);
    const cls = loadClients();
    cls[phoneNumber] = nome;
    saveClients(cls);
    // Reset history so system prompt reflects the new name
    chatHistory[phoneNumber] = [];
    text = text.replace(nameMatch[0], '').trim();
  }

  // Process [calcularFrete:...]
  const freteMatch = text.match(/\[calcularFrete:([^\]]+)\]/i);
  if (freteMatch) {
    const addr     = freteMatch[1].trim();
    const resultado = await calcularFrete(addr);
    const freteStr  = resultado
      ? `R$ ${resultado.frete.toFixed(2).replace('.', ',')}`
      : '(não calculado — atendente irá verificar)';
    text = text.replace(freteMatch[0], freteStr).trim();
  }

  // Save turn to history
  chatHistory[phoneNumber].push(
    { role: 'user',  parts: [{ text: userMessage }] },
    { role: 'model', parts: [{ text }] },
  );

  // Keep history bounded (last 40 turns = 80 entries)
  if (chatHistory[phoneNumber].length > 80) {
    chatHistory[phoneNumber] = chatHistory[phoneNumber].slice(-80);
  }

  return text;
}

// ─── WhatsApp Bot ──────────────────────────────────────────────────────────────
function startBot() {
  if (waClient) return;

  waClient = new Client({
    authStrategy: new LocalAuth({
      clientId: 'klebinho-bot',
      dataPath:  path.join(DATA_DIR, '.wwebjs_auth'),
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1017533896.html',
    },
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-features=MemorySaverMode',
        '--memory-pressure-off',
      ],
    },
  });

  waClient.on('qr', async (qr) => {
    console.log('[Bot] QR Code gerado — aguardando leitura...');
    currentQR = qr;
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      io.emit('qr', dataUrl);
    } catch (e) {
      console.error('[Bot] Erro ao gerar QR imagem:', e.message);
      io.emit('qr', qr);
    }
    io.emit('status', 'waiting_qr');
  });

  waClient.on('authenticated', () => {
    console.log('[Bot] Autenticado com sucesso!');
    io.emit('status', 'authenticated');
  });

  waClient.on('ready', () => {
    botRunning = true;
    currentQR  = null;
    io.emit('status', 'ready');
    io.emit('qr', null);
    console.log('[Bot] Pronto!');
  });

  waClient.on('auth_failure', (msg) => {
    console.error('[Bot] Falha de autenticacao:', msg);
    io.emit('status', 'auth_failure');
  });

  waClient.on('disconnected', (reason) => {
    botRunning = false;
    waClient   = null;
    io.emit('status', 'disconnected');
    console.log('[Bot] Desconectado:', reason);
  });

  // Debug: log every internal event emitted by the client
  const _origEmit = waClient.emit.bind(waClient);
  waClient.emit = function(event, ...args) {
    if (!['change_state', 'change_battery'].includes(event)) {
      console.log('[Event]', event, typeof args[0] === 'object' ? JSON.stringify(args[0]).substring(0, 120) : args[0]);
    }
    return _origEmit(event, ...args);
  };

  // Listen on both events for maximum compatibility
  const handleMessage = async (message) => {
    console.log('[RawMsg] fromMe:', message.fromMe, '| from:', message.from, '| type:', message.type, '| body:', (message.body || '').substring(0, 60));
    if (message.fromMe) return;
    if (message.from.endsWith('@g.us')) return;
    if (!message.from.endsWith('@c.us')) return;
    const body = message.body?.trim();
    if (!body) { console.log('[RawMsg] body vazio, ignorando'); return; }

    const phoneNumber = message.from.replace('@c.us', '');
    console.log('[Msg] De:', phoneNumber, '|', body.substring(0, 60));
    try {
      const reply = await chatWithGemini(phoneNumber, body);
      if (reply) {
        console.log('[Msg] Resposta para', phoneNumber + ':', reply.substring(0, 80));
        await message.reply(reply);
      }
    } catch (err) {
      console.error('[Bot] Erro ao responder:', err.message, err.stack);
    }
  };

  waClient.on('message', handleMessage);
  waClient.on('message_create', handleMessage);

  console.log('[Bot] Inicializando Chromium/WhatsApp Web...');
  waClient.initialize();
  io.emit('status', 'initializing');
}

async function stopBot() {
  console.log('[Bot] Encerrando...');
  if (waClient) {
    try { await waClient.destroy(); } catch {}
    waClient = null;
  }
  botRunning = false;
  currentQR  = null;
  io.emit('status', 'stopped');
  io.emit('qr', null);
}

// ─── REST API ──────────────────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { password } = req.body || {};
  if (password === PANEL_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Senha incorreta' });
});

app.post('/api/bot/start', verifyPassword, (_req, res) => {
  startBot();
  res.json({ success: true, message: 'Bot iniciando...' });
});

app.post('/api/bot/stop', verifyPassword, async (_req, res) => {
  await stopBot();
  res.json({ success: true, message: 'Bot parado.' });
});

app.get('/api/status', (_req, res) => {
  res.json({ botRunning, hasQR: !!currentQR });
});

app.get('/api/instructions', (_req, res) => {
  res.json({ instructions: getInstructions() });
});

app.post('/api/instructions', verifyPassword, (req, res) => {
  const { instructions } = req.body || {};
  if (typeof instructions !== 'string' || instructions.trim() === '') {
    return res.status(400).json({ error: 'Instruções inválidas' });
  }
  fs.writeFileSync(INSTRUCTIONS_FILE, instructions, 'utf8');
  res.json({ success: true });
});

// ─── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('status', botRunning ? 'ready' : 'stopped');
  if (currentQR) socket.emit('qr', currentQR);
});

// ─── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));
