(() => {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────────
  let password = null;
  const socket = io();

  // ─── Elements ─────────────────────────────────────────────────────────────────
  const loginScreen       = document.getElementById('login-screen');
  const panel             = document.getElementById('panel');
  const loginForm         = document.getElementById('login-form');
  const passwordInput     = document.getElementById('password-input');
  const loginError        = document.getElementById('login-error');
  const logoutBtn         = document.getElementById('logout-btn');

  const statusBadge       = document.getElementById('status-badge');
  const startBtn          = document.getElementById('start-btn');
  const stopBtn           = document.getElementById('stop-btn');
  const controlMsg        = document.getElementById('control-msg');

  const qrPlaceholder     = document.getElementById('qr-placeholder');
  const qrCanvas          = document.getElementById('qr-canvas');

  const instructionsArea  = document.getElementById('instructions-area');
  const saveBtn           = document.getElementById('save-btn');
  const saveMsg           = document.getElementById('save-msg');

  // ─── Status labels & badge classes ────────────────────────────────────────────
  const STATUS_LABELS = {
    initializing:  'Iniciando...',
    waiting_qr:    'Aguardando QR',
    authenticated: 'Autenticado',
    ready:         'Online ✓',
    disconnected:  'Desconectado',
    auth_failure:  'Falha Auth',
    stopped:       'Desligado',
  };

  function setStatus(status) {
    const label = STATUS_LABELS[status] || status;
    // Remove all badge-* classes
    statusBadge.className = statusBadge.className.replace(/badge-\S+/g, '').trim();
    statusBadge.classList.add('badge', `badge-${status}`);
    statusBadge.textContent = label;
  }

  // ─── QR Code rendering ────────────────────────────────────────────────────────
  function showQR(qrText) {
    if (!qrText) {
      qrCanvas.style.display = 'none';
      qrPlaceholder.style.display = '';
      qrPlaceholder.textContent = 'QR lido com sucesso! Bot conectado.';
      return;
    }
    QRCode.toCanvas(qrCanvas, qrText, { width: 220, margin: 2, color: { dark: '#000', light: '#fff' } }, (err) => {
      if (err) { console.error(err); return; }
      qrCanvas.style.display = 'block';
      qrPlaceholder.style.display = 'none';
    });
  }

  // ─── Login ────────────────────────────────────────────────────────────────────
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = passwordInput.value.trim();
    if (!pwd) return;

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      if (res.ok) {
        password = pwd;
        loginError.classList.add('hidden');
        loginScreen.classList.add('hidden');
        panel.classList.remove('hidden');
        loadInstructions();
      } else {
        loginError.classList.remove('hidden');
        passwordInput.value = '';
        passwordInput.focus();
      }
    } catch {
      loginError.textContent = 'Erro de conexão.';
      loginError.classList.remove('hidden');
    }
  });

  logoutBtn.addEventListener('click', () => {
    password = null;
    panel.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    passwordInput.value = '';
  });

  // ─── Bot controls ─────────────────────────────────────────────────────────────
  startBtn.addEventListener('click', async () => {
    await botAction('/api/bot/start');
  });

  stopBtn.addEventListener('click', async () => {
    await botAction('/api/bot/stop');
  });

  async function botAction(url) {
    startBtn.disabled = true;
    stopBtn.disabled  = true;
    controlMsg.textContent = 'Aguarde...';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      controlMsg.textContent = data.message || data.error || '';
    } catch {
      controlMsg.textContent = 'Erro de conexão.';
    } finally {
      startBtn.disabled = false;
      stopBtn.disabled  = false;
    }
  }

  // ─── Instructions ─────────────────────────────────────────────────────────────
  async function loadInstructions() {
    try {
      const res  = await fetch('/api/instructions');
      const data = await res.json();
      instructionsArea.value = data.instructions || '';
    } catch {
      instructionsArea.placeholder = 'Erro ao carregar instruções.';
    }
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveMsg.textContent = '';
    try {
      const res = await fetch('/api/instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, instructions: instructionsArea.value }),
      });
      const data = await res.json();
      if (res.ok) {
        saveMsg.textContent = '✓ Salvo com sucesso!';
        saveMsg.style.color = 'var(--success)';
      } else {
        saveMsg.textContent = data.error || 'Erro ao salvar.';
        saveMsg.style.color = 'var(--danger)';
      }
    } catch {
      saveMsg.textContent = 'Erro de conexão.';
      saveMsg.style.color = 'var(--danger)';
    } finally {
      saveBtn.disabled = false;
      setTimeout(() => { saveMsg.textContent = ''; }, 3000);
    }
  });

  // ─── Socket.io events ─────────────────────────────────────────────────────────
  socket.on('status', (status) => {
    setStatus(status);
    if (status === 'ready' || status === 'stopped' || status === 'disconnected') {
      // Clear QR when not needed
      if (status !== 'waiting_qr') {
        qrCanvas.style.display   = 'none';
        qrPlaceholder.style.display = '';
        qrPlaceholder.textContent = status === 'ready'
          ? '✓ Bot conectado!'
          : 'Aguardando QR code...';
      }
    }
  });

  socket.on('qr', (qrText) => {
    showQR(qrText);
  });

  socket.on('connect', () => {
    // Re-fetch status on reconnect
    fetch('/api/status')
      .then((r) => r.json())
      .then((d) => setStatus(d.botRunning ? 'ready' : 'stopped'))
      .catch(() => {});
  });

})();
