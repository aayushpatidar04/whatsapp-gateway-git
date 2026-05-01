const sessionsContainer = document.getElementById('sessions-container');
const loadingText       = document.getElementById('loading-text');
const logOutput         = document.getElementById('log-output');
const uiLogoutButton    = document.getElementById('ui-logout-button');

let pollTimer = null;

// ── Logging ───────────────────────────────────────────────────────────────────
function appendLog(message) {
    const ts = new Date().toLocaleTimeString();
    logOutput.textContent = `[${ts}] ${message}\n` + logOutput.textContent;
    // Keep log from growing unboundedly in the browser
    const lines = logOutput.textContent.split('\n');
    if (lines.length > 100) {
        logOutput.textContent = lines.slice(0, 100).join('\n');
    }
}

// ── Render all sessions ───────────────────────────────────────────────────────
function renderSessions(sessions) {
    if (loadingText) loadingText.remove();

    // Build a map of current cards
    const existingCards = {};
    sessionsContainer.querySelectorAll('.session-card').forEach(card => {
        existingCards[card.dataset.sessionId] = card;
    });

    const seenIds = new Set();

    for (const s of sessions) {
        seenIds.add(s.session_id);

        let card = existingCards[s.session_id];
        if (!card) {
            card = buildSessionCard(s.session_id);
            sessionsContainer.appendChild(card);
        }

        updateSessionCard(card, s);
    }

    // Remove cards for sessions that no longer exist
    for (const [id, card] of Object.entries(existingCards)) {
        if (!seenIds.has(id)) card.remove();
    }

    // Show placeholder when there are no sessions at all
    if (sessions.length === 0 && !document.getElementById('no-sessions-msg')) {
        const msg = document.createElement('p');
        msg.id = 'no-sessions-msg';
        msg.textContent = 'No sessions found. Add a company from the CRM to create a WhatsApp session.';
        msg.style.color = '#6b7280';
        sessionsContainer.appendChild(msg);
    } else {
        const msg = document.getElementById('no-sessions-msg');
        if (msg && sessions.length > 0) msg.remove();
    }
}

function buildSessionCard(sessionId) {
    const card = document.createElement('section');
    card.className = 'card session-card';
    card.dataset.sessionId = sessionId;

    card.innerHTML = `
      <div class="session-header">
        <h2 class="session-title">Session: <code>${sessionId}</code></h2>
        <span class="session-badge" data-badge></span>
      </div>
      <div class="status-row">
        <span>Status:</span>
        <strong data-status>—</strong>
      </div>
      <div class="status-row">
        <span>Phone:</span>
        <strong data-phone>—</strong>
      </div>
      <div class="qr-content" data-qr-content>
        <p>Waiting…</p>
      </div>
      <p class="hint">Open WhatsApp › Linked Devices › Link a Device to scan.</p>
      <div class="actions-card" style="margin-top:12px;">
        <button class="button button-secondary btn-logout" data-session-id="${sessionId}">
          Logout this session
        </button>
      </div>
    `;

    card.querySelector('.btn-logout').addEventListener('click', () => {
        if (confirm(`Disconnect WhatsApp for session "${sessionId}" and reset its QR?`)) {
            logoutSession(sessionId);
        }
    });

    return card;
}

function updateSessionCard(card, s) {
    const statusEl  = card.querySelector('[data-status]');
    const phoneEl   = card.querySelector('[data-phone]');
    const qrContent = card.querySelector('[data-qr-content]');
    const badge     = card.querySelector('[data-badge]');

    statusEl.textContent = s.status || 'unknown';
    phoneEl.textContent  = s.phone  || '—';

    // Badge colour
    badge.textContent = s.status;
    badge.className   = 'session-badge';
    if (s.status === 'connected')   badge.classList.add('badge-connected');
    else if (s.status === 'qr_ready') badge.classList.add('badge-qr');
    else                            badge.classList.add('badge-disconnected');

    if (s.status === 'qr_ready' && s.qr) {
        qrContent.innerHTML = `<img src="${s.qr}" alt="Scan QR for ${s.session_id}" style="max-width:260px;border-radius:8px;" />`;
    } else if (s.status === 'connected') {
        qrContent.innerHTML = `<p class="connected-text">✓ Connected as ${s.phone || 'unknown'}</p>`;
    } else if (s.status === 'connecting') {
        qrContent.innerHTML = '<p>Connecting… please wait.</p>';
    } else {
        qrContent.innerHTML = '<p>Disconnected. Gateway will auto-reconnect.</p>';
    }
}

// ── Fetch all session statuses ────────────────────────────────────────────────
async function fetchStatus() {
    try {
        const res = await fetch('/ui/status', {
            cache:       'no-store',
            credentials: 'include',
        });

        if (res.status === 401) {
            appendLog('Session expired — redirecting to login.');
            clearInterval(pollTimer);
            window.location.href = '/login';
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        renderSessions(data.sessions || []);
    } catch (err) {
        appendLog('Status fetch error: ' + err.message);
    }
}

// ── Logout a specific WA session ─────────────────────────────────────────────
async function logoutSession(sessionId) {
    appendLog(`Logging out session "${sessionId}"…`);
    try {
        const res = await fetch('/ui/logout', {
            method:      'POST',
            credentials: 'include',
            headers:     { 'Content-Type': 'application/json' },
            body:        JSON.stringify({ sessionId }),
        });

        if (res.status === 401) { window.location.href = '/login'; return; }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
        }
        appendLog(`Session "${sessionId}" logged out. A new QR will appear shortly.`);
        fetchStatus();
    } catch (err) {
        appendLog(`Logout error: ${err.message}`);
    }
}

// ── UI sign-out (browser session only, does not affect WA) ───────────────────
uiLogoutButton.addEventListener('click', async () => {
    clearInterval(pollTimer);
    await fetch('/ui/session-destroy', { method: 'POST', credentials: 'include' });
    window.location.href = '/login';
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
fetchStatus();
pollTimer = setInterval(fetchStatus, 5000);