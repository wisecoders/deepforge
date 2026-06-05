#!/usr/bin/env node
/**
 * Patches existing wiki index.html files to add the Deepforge chat UI.
 * Run inside the controller pod: node scripts/patch-wikis.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WIKIS_DIR = process.env.WIKIS_DIR || "/data/wikis";
const CONTROLLER_URL = process.env.CONTROLLER_URL || "http://deepforge.local";

const chatCss = `
    #df-chat-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 10000;
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg, #6366f1, #7c3aed);
      border: none; cursor: pointer;
      box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #df-chat-btn:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(99, 102, 241, 0.5); }
    #df-chat-btn svg { width: 24px; height: 24px; color: white; }
    #df-chat-panel {
      position: fixed; bottom: 88px; right: 24px; z-index: 10000;
      width: 420px; max-width: calc(100vw - 48px);
      height: 520px; max-height: calc(100vh - 120px);
      background: #1a1a2e; border: 1px solid #2d2d5e;
      border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      display: none; flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
    }
    #df-chat-panel.open { display: flex; }
    #df-chat-header {
      padding: 16px 20px; background: linear-gradient(135deg, #1e1e42, #252552);
      border-bottom: 1px solid #2d2d5e;
      display: flex; align-items: center; justify-content: space-between;
    }
    #df-chat-header h3 {
      margin: 0; font-size: 14px; font-weight: 600; color: #e2e8f0;
      display: flex; align-items: center; gap: 8px;
    }
    #df-chat-header h3::before {
      content: ''; width: 8px; height: 8px; border-radius: 50%;
      background: #10b981; display: inline-block;
    }
    #df-chat-close {
      background: none; border: none; cursor: pointer; color: #64748b;
      padding: 4px; border-radius: 6px; transition: color 0.15s, background 0.15s;
    }
    #df-chat-close:hover { color: #e2e8f0; background: rgba(99,102,241,0.1); }
    #df-chat-messages {
      flex: 1; overflow-y: auto; padding: 16px 20px;
      display: flex; flex-direction: column; gap: 12px;
    }
    #df-chat-messages::-webkit-scrollbar { width: 5px; }
    #df-chat-messages::-webkit-scrollbar-track { background: transparent; }
    #df-chat-messages::-webkit-scrollbar-thumb { background: #2d2d5e; border-radius: 3px; }
    .df-msg { max-width: 90%; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.6; }
    .df-msg-user { align-self: flex-end; background: #6366f1; color: white; border-bottom-right-radius: 4px; }
    .df-msg-ai { align-self: flex-start; background: #252552; color: #e2e8f0; border-bottom-left-radius: 4px; }
    .df-msg-ai code { background: #1a1a3e; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
    .df-msg-ai pre { background: #0f0f23; padding: 10px; border-radius: 8px; overflow-x: auto; margin: 8px 0; }
    .df-msg-ai pre code { background: none; padding: 0; }
    .df-msg-ai a { color: #818cf8; text-decoration: underline; }
    .df-msg-sources { margin-top: 8px; padding-top: 8px; border-top: 1px solid #2d2d5e; font-size: 11px; color: #94a3b8; }
    .df-msg-sources a { color: #6366f1; text-decoration: none; margin-right: 8px; }
    .df-msg-sources a:hover { text-decoration: underline; }
    .df-msg-loading { align-self: flex-start; padding: 12px 16px; }
    .df-msg-loading .dots { display: inline-flex; gap: 4px; }
    .df-msg-loading .dots span { width: 6px; height: 6px; border-radius: 50%; background: #6366f1; animation: df-bounce 1.4s infinite; }
    .df-msg-loading .dots span:nth-child(2) { animation-delay: 0.2s; }
    .df-msg-loading .dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes df-bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }
    #df-chat-input-area {
      padding: 12px 16px; border-top: 1px solid #2d2d5e;
      display: flex; gap: 8px; background: #1e1e42;
    }
    #df-chat-input {
      flex: 1; background: #0f0f23; border: 1px solid #2d2d5e;
      border-radius: 10px; padding: 10px 14px;
      font-size: 13px; color: #e2e8f0; outline: none;
      font-family: inherit; resize: none; transition: border-color 0.2s;
    }
    #df-chat-input:focus { border-color: #6366f1; }
    #df-chat-input::placeholder { color: #64748b; }
    #df-chat-send {
      background: #6366f1; border: none; border-radius: 10px;
      width: 38px; height: 38px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    #df-chat-send:hover { background: #818cf8; }
    #df-chat-send:disabled { opacity: 0.5; cursor: not-allowed; }
    #df-chat-send svg { width: 18px; height: 18px; color: white; }
    .df-welcome { text-align: center; padding: 24px 16px; color: #94a3b8; }
    .df-welcome h4 { color: #e2e8f0; margin-bottom: 8px; font-size: 14px; }
    .df-welcome p { font-size: 12px; line-height: 1.5; }`;

const chatHtml = `
  <button id="df-chat-btn" title="Ask about this codebase" onclick="document.getElementById('df-chat-panel').classList.toggle('open')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  </button>
  <div id="df-chat-panel">
    <div id="df-chat-header">
      <h3>Ask Deepforge</h3>
      <button id="df-chat-close" onclick="document.getElementById('df-chat-panel').classList.remove('open')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div id="df-chat-messages">
      <div class="df-welcome">
        <h4>Ask anything about this codebase</h4>
        <p>I can answer questions about architecture, patterns, components, and implementation details covered in this wiki.</p>
      </div>
    </div>
    <div id="df-chat-input-area">
      <input type="text" id="df-chat-input" placeholder="How does the authentication flow work?" autocomplete="off">
      <button id="df-chat-send" onclick="dfSend()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
  </div>`;

const chatScript = `<script>
(function() {
  var CONTROLLER = '${CONTROLLER_URL}';
  var loc = window.location;
  if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
    CONTROLLER = loc.protocol + '//' + loc.hostname + ':9091';
  }
  var input = document.getElementById('df-chat-input');
  var messages = document.getElementById('df-chat-messages');
  var sendBtn = document.getElementById('df-chat-send');
  var SLUG = loc.hostname.split('.')[0] || '';
  if (!SLUG || SLUG === 'localhost') {
    var m = loc.pathname.match(/\\/wiki\\/([^\\/]+)/);
    if (m) SLUG = m[1];
  }

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dfSend(); }
  });

  window.dfSend = function() {
    var q = input.value.trim();
    if (!q) return;
    addMsg(q, 'user');
    input.value = '';
    sendBtn.disabled = true;
    var welcome = messages.querySelector('.df-welcome');
    if (welcome) welcome.remove();
    var loading = document.createElement('div');
    loading.className = 'df-msg df-msg-ai df-msg-loading';
    loading.innerHTML = '<div class="dots"><span></span><span></span><span></span></div>';
    messages.appendChild(loading);
    messages.scrollTop = messages.scrollHeight;
    fetch(CONTROLLER + '/api/wikis/' + SLUG + '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    }).then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })
    .then(function(r) {
      loading.remove();
      if (r.ok) { addAiMsg(r.data.answer, r.data.sources || []); }
      else { addMsg('Error: ' + (r.data.error || 'Unknown'), 'ai'); }
    }).catch(function() {
      loading.remove();
      addMsg('Connection error. Is the Deepforge controller running?', 'ai');
    }).finally(function() { sendBtn.disabled = false; });
  };

  function addMsg(text, role) {
    var div = document.createElement('div');
    div.className = 'df-msg df-msg-' + role;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function addAiMsg(md, sources) {
    var div = document.createElement('div');
    div.className = 'df-msg df-msg-ai';
    div.innerHTML = renderMd(md);
    if (sources && sources.length > 0) {
      var s = document.createElement('div');
      s.className = 'df-msg-sources';
      s.innerHTML = 'Sources: ' + sources.map(function(x) { return '<a href="#/' + x.page + '">' + x.title + '</a>'; }).join('');
      div.appendChild(s);
    }
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function renderMd(md) {
    return md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\`\`\`[\\w]*\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
      .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\\n\\n/g, '<br><br>')
      .replace(/\\n/g, '<br>');
  }
})();
</script>`;

const wikis = readdirSync(WIKIS_DIR);
for (const slug of wikis) {
  const indexPath = join(WIKIS_DIR, slug, "index.html");
  try {
    let html = readFileSync(indexPath, "utf-8");

    // Skip if already patched
    if (html.includes("df-chat-btn")) {
      console.log("Already patched:", slug);
      continue;
    }

    // Inject CSS before </style>
    html = html.replace("</style>", chatCss + "\n  </style>");

    // Inject chat HTML before <div id="app">
    html = html.replace('<div id="app">', chatHtml + '\n  <div id="app">');

    // Inject script before </body>
    html = html.replace("</body>", chatScript + "\n</body>");

    writeFileSync(indexPath, html);
    console.log("Patched:", slug);
  } catch (e) {
    console.log("Error:", slug, e.message);
  }
}
console.log("Done!");
