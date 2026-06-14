import { auth, db, googleProvider } from './firebase.js';
import {
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  ref, get, set, push, update, remove, onValue, off
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ─── State ────────────────────────────────────────────────────
let currentUser   = null;
let userProfile   = {};
let userMemories  = {};     // { id: { text, savedAt } }
let conversations = {};     // { id: { title, messages:{} } }
let activeChatId  = null;
let pendingImage  = null;
let generating    = false;
let convListener  = null;   // Firebase listener ref for cleanup

// ─── Database Path Helpers (User Isolation) ───────────────────
// All data is scoped to the authenticated user's UID
function userPath(uid)        { return `users/${uid}`; }
function memoryPath(uid)      { return `users/${uid}/memory`; }
function chatDbPath(uid)      { return `users/${uid}/chatDatabase`; }
function chatPath(uid, chatId){ return `users/${uid}/chatDatabase/${chatId}`; }
function msgsPath(uid, chatId){ return `users/${uid}/chatDatabase/${chatId}/messages`; }
function settingsPath(uid)    { return `users/${uid}/settings`; }

// ─── DOM refs ─────────────────────────────────────────────────
const initLoader     = document.getElementById('initLoader');
const appEl          = document.getElementById('app');
const sidebar        = document.getElementById('sidebar');
const chatList       = document.getElementById('chatList');
const sbAvatar       = document.getElementById('sbAvatar');
const sbName         = document.getElementById('sbName');
const sbEmail        = document.getElementById('sbEmail');
const feed           = document.getElementById('feed');
const welcome        = document.getElementById('welcome');
const wlcGreeting    = document.getElementById('wlcGreeting');
const messages       = document.getElementById('messages');
const prompt         = document.getElementById('prompt');
const btnSend        = document.getElementById('btnSend');
const fileImg        = document.getElementById('fileImg');
const imgPreviewBar  = document.getElementById('imgPreviewBar');
const imgThumb       = document.getElementById('imgThumb');
const btnRemoveImg   = document.getElementById('btnRemoveImg');
const settingsPanel  = document.getElementById('settingsPanel');
const panelBackdrop  = document.getElementById('panelBackdrop');

// ─── marked.js setup ──────────────────────────────────────────
if (window.marked) {
  marked.use({
    gfm: true, breaks: true,
    renderer: (() => {
      const r = new marked.Renderer();
      r.code = ({ text, lang }) => {
        const l = lang || 'plaintext';
        const e = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<div class="code-block"><div class="code-block-head"><span>${l}</span>
          <button class="code-copy-btn" onclick="copyBlock(this)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy</button></div><pre><code class="language-${l} hljs">${e}</code></pre></div>`;
      };
      return r;
    })()
  });
}
window.copyBlock = btn => {
  const code = btn.closest('.code-block').querySelector('code');
  navigator.clipboard.writeText(code.innerText).then(() => {
    const orig = btn.innerHTML;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
};

// ─── Auth State ───────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.replace('/auth.html');
    return;
  }
  currentUser = user;
  await bootstrapUser();
  initLoader.style.display = 'none';
  appEl.style.display = 'flex';
});

// ─── User Bootstrap (Strict User Isolation) ───────────────────
async function bootstrapUser() {
  const uid = currentUser.uid;

  // Load ONLY this user's profile
  const profileSnap = await get(ref(db, userPath(uid)));
  if (profileSnap.exists()) {
    userProfile = profileSnap.val();
  }

  // Ensure avatar/name updated from Google
  await update(ref(db, userPath(uid)), {
    email:       currentUser.email,
    displayName: currentUser.displayName || userProfile.displayName || '',
    photoURL:    currentUser.photoURL    || userProfile.photoURL    || ''
  });
  userProfile.email       = currentUser.email;
  userProfile.displayName = currentUser.displayName || userProfile.displayName || '';
  userProfile.photoURL    = currentUser.photoURL    || '';

  // Load ONLY this user's memories
  const memSnap = await get(ref(db, memoryPath(uid)));
  userMemories = memSnap.exists() ? memSnap.val() : {};

  // Populate UI
  updateSidebarUser();
  setGreeting();
  setupConvListener();
  setupEventListeners();
  populateSettingsPanel();
}

function updateSidebarUser() {
  sbAvatar.src = userProfile.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(userProfile.displayName||'U')}&background=19c37d&color=fff&size=64`;
  sbName.textContent  = userProfile.displayName || 'User';
  sbEmail.textContent = userProfile.email || '';

  const sa = document.getElementById('settingsAvatar');
  const sn = document.getElementById('settingsName');
  const se = document.getElementById('settingsEmail');
  if (sa) sa.src = sbAvatar.src;
  if (sn) sn.textContent = userProfile.displayName || '';
  if (se) se.textContent = userProfile.email || '';
}

function setGreeting() {
  const h = new Date().getHours();
  const tod = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const name = userProfile.displayName?.split(' ')[0] || '';
  wlcGreeting.textContent = name ? `${tod}, ${name}! 👋` : `${tod}! 👋`;
}

// ─── Firebase conversation listener (User-Scoped) ─────────────
function setupConvListener() {
  const uid = currentUser.uid;
  if (convListener) off(ref(db, chatDbPath(uid)), 'value', convListener);
  const convRef = ref(db, chatDbPath(uid));
  convListener = onValue(convRef, snap => {
    conversations = snap.exists() ? snap.val() : {};
    renderSidebar();
  });
}

// ─── Sidebar ──────────────────────────────────────────────────
function renderSidebar() {
  chatList.innerHTML = '';
  const sorted = Object.entries(conversations)
    .sort(([,a],[,b]) => (b.createdAt||0) - (a.createdAt||0));

  if (sorted.length === 0) {
    chatList.innerHTML = `<div style="text-align:center;color:var(--text-muted);font-size:.8rem;padding:16px 0">No chats yet</div>`;
    return;
  }

  sorted.forEach(([id, chat]) => {
    const el = document.createElement('div');
    el.className = 'chat-item' + (id === activeChatId ? ' active' : '');
    el.innerHTML = `<span class="ci-title">${esc(chat.title || 'Untitled')}</span>
      <button class="ci-del" title="Delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>`;
    el.querySelector('.ci-title').addEventListener('click', () => loadChat(id));
    el.querySelector('.ci-del').addEventListener('click', e => { e.stopPropagation(); deleteChat(id); });
    chatList.appendChild(el);
  });
}

// ─── Chat load/create (User-Scoped) ───────────────────────────
function startNewChat() {
  activeChatId = null;
  messages.innerHTML = '';
  welcome.style.display = '';
  clearImage();
  prompt.value = ''; resizePrompt(); checkSend();
  renderSidebar();
}

async function loadChat(id) {
  const uid = currentUser.uid;
  activeChatId = id;
  messages.innerHTML = '';
  welcome.style.display = 'none';
  renderSidebar();

  // Load ONLY this user's messages for this chat
  const snap = await get(ref(db, msgsPath(uid, id)));
  if (snap.exists()) {
    const msgs = snap.val();
    Object.entries(msgs)
      .sort(([,a],[,b]) => a.timestamp - b.timestamp)
      .forEach(([,m]) => renderMessage(m.role, m.content, false));
  }
  scrollFeed();
}

async function deleteChat(id) {
  const uid = currentUser.uid;
  // Delete ONLY this user's chat
  await remove(ref(db, chatPath(uid, id)));
  if (activeChatId === id) startNewChat();
}

// ─── Memory Engine (User-Scoped) ──────────────────────────────
const MEMORY_PATTERNS = [
  /(?:remember|recall|save|note|keep in mind|don't forget)[:\s]+(.+)/i,
  /(?:my name is|i'm called|call me)\s+([A-Za-z ]+)/i,
  /(?:i am|i'm|i work as|i'm a|i'm an)\s+(.+)/i,
  /(?:i prefer|i like|i love|i enjoy)\s+(.+)/i,
  /(?:i live in|i'm from|i'm based in)\s+(.+)/i,
];

async function detectAndSaveMemory(text) {
  const uid = currentUser.uid;
  for (const pattern of MEMORY_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const memText = text.length < 200 ? text : match[1]?.trim();
      if (memText && memText.length > 3) {
        // Save to this user's memory only
        const memRef = push(ref(db, memoryPath(uid)));
        const entry  = { text: memText, savedAt: Date.now() };
        await set(memRef, entry);
        userMemories[memRef.key] = entry;
        showMemoryToast(`Remembered: "${memText.slice(0,60)}${memText.length>60?'…':''}"`);
        refreshMemoryTab();
        return true;
      }
    }
  }
  return false;
}

function showMemoryToast(msg) {
  const t = document.createElement('div');
  t.className = 'memory-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ─── Context Builder (User-Scoped) ────────────────────────────
function buildSystemContext() {
  const p = userProfile;
  let ctx = 'You are a personal AI assistant with memory. Be helpful, warm, and personalized.\n\n';

  // Profile
  const profileParts = [];
  if (p.displayName) profileParts.push(`Name: ${p.displayName}`);
  if (p.occupation)  profileParts.push(`Occupation: ${p.occupation}`);
  if (p.location)    profileParts.push(`Location: ${p.location}`);
  if (p.bio)         profileParts.push(`Bio: ${p.bio}`);
  if (p.dateOfBirth) profileParts.push(`Date of Birth: ${p.dateOfBirth}`);
  if (profileParts.length) ctx += `## User Profile\n${profileParts.join('\n')}\n\n`;

  // Memories (only this user's)
  const mems = Object.values(userMemories);
  if (mems.length) {
    ctx += `## Saved Memories\n${mems.map(m => `- ${m.text}`).join('\n')}\n\n`;
  }

  // Settings preferences
  const s = p.settings || {};
  if (s.responseStyle)  ctx += `Response style: ${s.responseStyle}.\n`;
  if (s.responseLength) ctx += `Response length: ${s.responseLength}.\n`;
  if (s.language && s.language !== 'English') ctx += `Respond in ${s.language}.\n`;

  ctx += '\nAddress the user by first name when appropriate. Use their memories to give personalised responses.';
  return ctx;
}

// ─── Render Message ───────────────────────────────────────────
function renderMessage(role, content, animate = true) {
  welcome.style.display = 'none';
  const group = document.createElement('div');
  group.className = 'msg-group';
  if (!animate) group.style.animation = 'none';

  if (role === 'user') {
    if (Array.isArray(content)) {
      const img = content.find(p => p.type === 'image_url');
      const txt = content.find(p => p.type === 'text');
      if (img) {
        const d = document.createElement('div');
        d.className = 'msg-img';
        d.innerHTML = `<img src="${img.image_url.url}" alt="attachment">`;
        group.appendChild(d);
      }
      if (txt?.text) {
        const b = document.createElement('div');
        b.className = 'msg-user';
        b.textContent = txt.text;
        group.appendChild(b);
      }
    } else {
      const b = document.createElement('div');
      b.className = 'msg-user';
      b.textContent = content;
      group.appendChild(b);
    }
  } else {
    const wrap   = document.createElement('div');
    wrap.className = 'msg-ai-wrap';
    const avatar = document.createElement('div');
    avatar.className = 'ai-avatar'; avatar.textContent = 'M3';
    const bubble = document.createElement('div');
    bubble.className = 'msg-ai';
    if (content) {
      bubble.innerHTML = window.marked ? marked.parse(content) : esc(content);
      hlAll(bubble);
    }
    wrap.appendChild(avatar); wrap.appendChild(bubble);
    group.appendChild(wrap);
    group._aiBubble = bubble;
  }
  messages.appendChild(group);
  scrollFeed();
  return group;
}

function hlAll(el) {
  if (!window.hljs) return;
  el.querySelectorAll('pre code').forEach(b => { if (!b.dataset.highlighted) hljs.highlightElement(b); });
}

function addTyping() {
  const g = document.createElement('div');
  g.className = 'msg-group'; g.id = 'typingEl';
  g.innerHTML = `<div class="msg-ai-wrap"><div class="ai-avatar">M3</div>
    <div class="msg-ai"><div class="typing-dots"><span></span><span></span><span></span></div></div></div>`;
  messages.appendChild(g); scrollFeed();
}
function removeTyping() { document.getElementById('typingEl')?.remove(); }

// ─── Send Message (User-Scoped with Error Handling) ───────────
async function submitMessage() {
  const text  = prompt.value.trim();
  const image = pendingImage;
  if (!text && !image) return;

  const uid = currentUser.uid;
  generating = true; checkSend();
  prompt.value = ''; resizePrompt(); clearImage();

  // Detect memory save intent (saves to THIS user's memory only)
  if (text) detectAndSaveMemory(text);

  // Build user content
  let userContent;
  if (image) {
    userContent = [];
    if (text) userContent.push({ type: 'text', text });
    userContent.push({ type: 'image_url', image_url: { url: image } });
  } else {
    userContent = text;
  }

  // Create new conversation in THIS user's DB if needed
  if (!activeChatId) {
    const newRef = push(ref(db, chatDbPath(uid)));
    activeChatId = newRef.key;
    await set(newRef, {
      title: (text || 'Image').slice(0, 40),
      createdAt: Date.now(),
      messages: {}
    });
    renderSidebar();
  }

  // Save user message to THIS user's chat
  const userMsgRef = push(ref(db, msgsPath(uid, activeChatId)));
  await set(userMsgRef, { role: 'user', content: userContent, timestamp: Date.now() });

  renderMessage('user', userContent);
  addTyping();

  // Build API payload — system context + THIS user's conversation history only
  const histSnap = await get(ref(db, msgsPath(uid, activeChatId)));
  const histMsgs = histSnap.exists()
    ? Object.values(histSnap.val()).sort((a,b) => a.timestamp - b.timestamp)
    : [];

  const apiMessages = [
    { role: 'system', content: buildSystemContext() },
    ...histMsgs.map(m => ({ role: m.role, content: m.content }))
  ];

  let aiGroup  = null;
  let aiBubble = null;
  let fullText = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages:    apiMessages,
        temperature: (userProfile.settings?.creativity ?? 1.0),
        top_p:       0.95
      })
    });

    removeTyping();

    if (!res.ok) {
      renderMessage('assistant', '⚠️ The AI service is temporarily unavailable. Please try again.');
      generating = false; checkSend(); return;
    }

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      // ── SSE streaming response ──
      aiGroup  = renderMessage('assistant', '');
      aiBubble = aiGroup._aiBubble;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') break;

          try {
            const data = JSON.parse(dataStr);
            if (data.error) {
              fullText = `⚠️ ${esc(String(data.error))}`;
              aiBubble.innerHTML = fullText;
              break;
            }
            const delta = data.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullText += delta;
              aiBubble.innerHTML = window.marked ? marked.parse(fullText) : esc(fullText);
              hlAll(aiBubble);
              scrollFeed();
            }
          } catch (_) {}
        }
      }
    } else {
      // ── JSON fallback (non-streaming) ──
      const data = await res.json();

      if (data.error) {
        fullText = `⚠️ ${esc(String(data.error))}`;
        renderMessage('assistant', fullText);
        console.warn('API error:', { type: data.errorType, message: data.error });
      } else {
        fullText = data.content || '';
        aiGroup  = renderMessage('assistant', '');
        aiBubble = aiGroup._aiBubble;
        if (fullText) {
          aiBubble.innerHTML = window.marked ? marked.parse(fullText) : esc(fullText);
          hlAll(aiBubble);
          scrollFeed();
        } else {
          aiBubble.innerHTML = '<span style="color:var(--text-muted)">No response generated.</span>';
        }
      }
    }

  } catch (err) {
    console.error('Fetch error:', err);
    removeTyping();
    const friendlyMsg = getNetworkErrorMessage(err);
    if (!fullText) renderMessage('assistant', `⚠️ ${friendlyMsg}`);
  } finally {
    if (fullText && activeChatId) {
      const aiMsgRef = push(ref(db, msgsPath(uid, activeChatId)));
      await set(aiMsgRef, { role: 'assistant', content: fullText, timestamp: Date.now() });
    }
    generating = false; checkSend();
  }
}

// ─── Network Error Message Helper ─────────────────────────────
function getNetworkErrorMessage(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('failed to fetch') || msg.includes('networkerror')) {
    return 'Connection lost. Please check your internet connection.';
  }
  if (msg.includes('aborted') || msg.includes('timeout')) {
    return 'The AI service is taking too long. Please try again.';
  }
  if (msg.includes('refused') || msg.includes('unavailable')) {
    return 'The AI service is temporarily unavailable. Please try again.';
  }
  return 'An unexpected error occurred. Please try again.';
}

// ─── Settings Panel ───────────────────────────────────────────
function openSettings(tab = 'profile') {
  populateSettingsPanel();
  switchTab(tab);
  settingsPanel.style.display = 'flex';
  panelBackdrop.style.display = 'block';
}
function closeSettings() {
  settingsPanel.style.display = 'none';
  panelBackdrop.style.display = 'none';
}

function switchTab(name) {
  document.querySelectorAll('.ptab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel-tab-content').forEach(c => c.style.display = 'none');
  const target = document.getElementById(`tab${name.charAt(0).toUpperCase() + name.slice(1)}`);
  if (target) target.style.display = 'flex';
}

function populateSettingsPanel() {
  const p = userProfile;
  const s = p.settings || {};

  // Profile fields
  const fName = document.getElementById('fName');
  if (fName) fName.value = p.displayName || '';
  const fDob = document.getElementById('fDob');
  if (fDob) fDob.value = p.dateOfBirth || '';
  const fGender = document.getElementById('fGender');
  if (fGender) fGender.value = p.gender || '';
  const fOccupation = document.getElementById('fOccupation');
  if (fOccupation) fOccupation.value = p.occupation || '';
  const fLocation = document.getElementById('fLocation');
  if (fLocation) fLocation.value = p.location || '';
  const fBio = document.getElementById('fBio');
  if (fBio) fBio.value = p.bio || '';

  // AI prefs
  const fStyle = document.getElementById('fStyle');
  if (fStyle) fStyle.value = s.responseStyle || 'balanced';
  const fLength = document.getElementById('fLength');
  if (fLength) fLength.value = s.responseLength || 'medium';
  const fTemp = document.getElementById('fTemp');
  const tempLabel = document.getElementById('tempLabel');
  if (fTemp) { fTemp.value = s.creativity ?? 1.0; if (tempLabel) tempLabel.textContent = fTemp.value; }
  const fLang = document.getElementById('fLang');
  if (fLang) fLang.value = s.language || 'English';

  refreshMemoryTab();
  updateSidebarUser();
}

function refreshMemoryTab() {
  const list  = document.getElementById('memoryList');
  const empty = document.getElementById('memoryEmpty');
  if (!list) return;
  list.innerHTML = '';
  const entries = Object.entries(userMemories);
  if (entries.length === 0) {
    if (empty) empty.style.display = 'block';
  } else {
    if (empty) empty.style.display = 'none';
    entries.sort(([,a],[,b]) => b.savedAt - a.savedAt).forEach(([id, mem]) => {
      const chip = document.createElement('div');
      chip.className = 'memory-chip';
      chip.innerHTML = `<span class="memory-chip-text">${esc(mem.text)}</span>
        <button class="memory-del" title="Delete memory">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>`;
      chip.querySelector('.memory-del').addEventListener('click', async () => {
        const uid = currentUser.uid;
        // Delete from THIS user's memory only
        await remove(ref(db, `${memoryPath(uid)}/${id}`));
        delete userMemories[id];
        refreshMemoryTab();
      });
      list.appendChild(chip);
    });
  }
}

// ─── Event Listeners ──────────────────────────────────────────
function setupEventListeners() {

  // Sidebar toggles
  document.getElementById('btnCloseSidebar').addEventListener('click', () => sidebar.classList.add('collapsed'));
  document.getElementById('btnOpenSidebar').addEventListener('click',  () => sidebar.classList.remove('collapsed'));
  document.getElementById('btnNewChat').addEventListener('click', startNewChat);
  document.getElementById('btnClearChat').addEventListener('click', startNewChat);

  // Sign out
  const signOutHandler = () => signOut(auth).then(() => window.location.replace('/auth.html'));
  document.getElementById('btnSignOut').addEventListener('click', signOutHandler);
  document.getElementById('btnSignOutSettings').addEventListener('click', signOutHandler);

  // Settings open/close
  document.getElementById('btnSettings').addEventListener('click', () => openSettings('profile'));
  document.getElementById('btnUserProfile').addEventListener('click', () => openSettings('profile'));
  document.getElementById('btnCloseSettings').addEventListener('click', closeSettings);
  panelBackdrop.addEventListener('click', closeSettings);

  // Settings tabs
  document.querySelectorAll('.ptab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // Save profile (THIS user only)
  document.getElementById('btnSaveProfile').addEventListener('click', async () => {
    const uid = currentUser.uid;
    const updates = {
      displayName: document.getElementById('fName').value.trim(),
      dateOfBirth: document.getElementById('fDob').value,
      gender:      document.getElementById('fGender').value,
      occupation:  document.getElementById('fOccupation').value.trim(),
      location:    document.getElementById('fLocation').value.trim(),
      bio:         document.getElementById('fBio').value.trim()
    };
    await update(ref(db, userPath(uid)), updates);
    Object.assign(userProfile, updates);
    updateSidebarUser();
    setGreeting();
    showMemoryToast('Profile saved ✓');
  });

  // Save AI prefs (THIS user only)
  document.getElementById('btnSaveAi').addEventListener('click', async () => {
    const uid = currentUser.uid;
    const settings = {
      responseStyle:  document.getElementById('fStyle').value,
      responseLength: document.getElementById('fLength').value,
      creativity:     parseFloat(document.getElementById('fTemp').value),
      language:       document.getElementById('fLang').value
    };
    await update(ref(db, settingsPath(uid)), settings);
    userProfile.settings = { ...(userProfile.settings || {}), ...settings };
    showMemoryToast('Preferences saved ✓');
  });

  // Temperature label
  document.getElementById('fTemp').addEventListener('input', e => {
    document.getElementById('tempLabel').textContent = parseFloat(e.target.value).toFixed(2);
  });

  // Privacy actions (THIS user's data only)
  document.getElementById('btnDeleteChats').addEventListener('click', async () => {
    if (!confirm('Delete ALL chat history? This cannot be undone.')) return;
    const uid = currentUser.uid;
    await remove(ref(db, chatDbPath(uid)));
    conversations = {};
    startNewChat();
    showMemoryToast('Chat history deleted');
  });

  document.getElementById('btnDeleteMemories').addEventListener('click', async () => {
    if (!confirm('Delete ALL saved memories?')) return;
    const uid = currentUser.uid;
    await remove(ref(db, memoryPath(uid)));
    userMemories = {};
    refreshMemoryTab();
    showMemoryToast('Memories deleted');
  });

  document.getElementById('btnExport').addEventListener('click', async () => {
    const uid = currentUser.uid;
    // Export ONLY this user's data
    const data = { profile: userProfile, memories: userMemories, conversations };
    const blob  = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href = url; a.download = `ai-chat-export-${uid.slice(0,8)}-${Date.now()}.json`;
    a.click(); URL.revokeObjectURL(url);
  });

  // Input
  prompt.addEventListener('input', () => { resizePrompt(); checkSend(); });
  prompt.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !generating) { e.preventDefault(); if (!btnSend.disabled) submitMessage(); }
  });
  btnSend.addEventListener('click', submitMessage);

  // File upload
  fileImg.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { pendingImage = ev.target.result; imgThumb.src = pendingImage; imgPreviewBar.style.display = 'block'; checkSend(); };
    reader.readAsDataURL(file);
  });
  btnRemoveImg.addEventListener('click', clearImage);

  // Suggestion chips
  document.querySelectorAll('.sugg-pill').forEach(btn => {
    btn.addEventListener('click', () => { prompt.value = btn.dataset.text; resizePrompt(); checkSend(); prompt.focus(); });
  });
}

// ─── Helpers ──────────────────────────────────────────────────
function resizePrompt() {
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, 200) + 'px';
}
function checkSend() {
  btnSend.disabled = (!prompt.value.trim() && !pendingImage) || generating;
}
function clearImage() {
  pendingImage = null; fileImg.value = '';
  imgPreviewBar.style.display = 'none'; checkSend();
}
function scrollFeed() { feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' }); }
function esc(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
