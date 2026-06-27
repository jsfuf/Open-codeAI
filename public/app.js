import { auth, db, googleProvider } from './firebase.js?v=3';
import {
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  ref, get, set, push, update, remove, onValue, off
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const API_CONFIG = {
  'gemini-2.5-flash': {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
  },
  'gemini-2.5-flash-lite': {
    provider: 'gemini',
    model: 'gemini-2.5-flash-lite',
  },
};

const IMAGE_MODELS = [
  'gemini-2.5-flash-image',
  'gemini-3-pro-image',
  'gemini-3.1-flash-image',
];

const IMAGE_KEYWORDS = /generat|creat|draw|image|picture|photo|illustrat|design|make.*image|make.*photo|make.*picture|render|sketch|paint|artwork/i;

// ─── State ────────────────────────────────────────────────────
let currentUser   = null;
let userProfile   = {};
let userMemories  = {};     // { id: { text, savedAt } }
let conversations = {};     // { id: { title, messages:{} } }
let activeChatId  = null;
let pendingImage  = null;
let generating    = false;
let currentAbort  = null;   // AbortController for current request
let convListener  = null;   // Firebase listener ref for cleanup
let userProfileListener = null;  // Real-time profile listener
let selectedModel = 'deepseek-chat';  // Default DeepSeek model

// ─── Database Path Helpers (User Isolation) ───────────────────
// All data is scoped to the authenticated user's UID
function userPath(uid)        { return `users/${uid}`; }
function memoryPath(uid)      { return `users/${uid}/memory`; }
function savedPicPath(uid)    { return `users/${uid}/savedPic`; }
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
const btnStop        = document.getElementById('btnStop');
const fileImg        = document.getElementById('fileImg');
const imgPreviewBar  = document.getElementById('imgPreviewBar');
const imgThumb       = document.getElementById('imgThumb');
const btnRemoveImg   = document.getElementById('btnRemoveImg');
const settingsPanel  = document.getElementById('settingsPanel');
const panelBackdrop  = document.getElementById('panelBackdrop');
const modelSwitcherBtn = document.getElementById('modelSwitcher');
const modelDropdown  = document.getElementById('modelDropdown');
const modelSwitcherLabel = document.getElementById('modelSwitcherLabel');

// ─── marked.js setup ──────────────────────────────────────────
if (window.marked) {
  marked.use({
    gfm: true, breaks: true,
    renderer: (() => {
      const r = new marked.Renderer();
      r.code = ({ text, lang }) => {
        const l = lang || 'text';
        const e = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<div class="code-block">
          <div class="code-block-head">
            <span>${l}</span>
            <button class="code-copy-btn" onclick="copyBlock(this)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy code
            </button>
          </div>
          <pre><code class="language-${l} hljs">${e}</code></pre>
        </div>`;
      };
      return r;
    })()
  });
}
window.copyBlock = btn => {
  const code = btn.closest('.code-block').querySelector('code');
  navigator.clipboard.writeText(code.innerText).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
    btn.style.color = '#10a37f';
    setTimeout(() => {
      btn.innerHTML = orig;
      btn.style.color = '';
    }, 2000);
  });
};
window.copyMessage = btn => {
  const msg = btn.closest('.msg-group').querySelector('.msg-ai');
  if (!msg) return;
  const text = msg.innerText || msg.textContent;
  navigator.clipboard.writeText(text.trim()).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
};

// ─── Auth State ───────────────────────────────────────────────
setTimeout(() => {
  if (initLoader && initLoader.style.display !== 'none') {
    console.warn('[App] Timeout: force-showing app');
    initLoader.style.display = 'none';
    appEl.style.display = 'flex';
  }
}, 6000);

onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.replace('/auth.html');
    return;
  }
  currentUser = user;

  try {
    await bootstrapUser();
  } catch (e) {
    console.error('[App] Bootstrap error:', e);
  }
  initLoader.style.display = 'none';
  appEl.style.display = 'flex';
});

// ─── User Bootstrap (Strict User Isolation) ───────────────────
async function bootstrapUser() {
  const uid = currentUser.uid;

  // Run GETs concurrently to speed up loading
  try {
    const [profileSnap, memSnap] = await Promise.all([
      get(ref(db, userPath(uid))).catch(e => { console.warn('[App] Failed to load profile:', e); return null; }),
      get(ref(db, memoryPath(uid))).catch(e => { console.warn('[App] Failed to load memories:', e); return null; })
    ]);

    if (profileSnap && profileSnap.exists()) {
      userProfile = profileSnap.val();
    }

    // Fallback: try loading profile pic from savedPic if not in user data
    if (!userProfile.photoURL) {
      try {
        const picSnap = await get(ref(db, `users/${uid}/savedPic/profilePic`));
        if (picSnap.exists() && picSnap.val().url) {
          userProfile.photoURL = picSnap.val().url;
        }
      } catch (_) {}
    }
    
    if (memSnap && memSnap.exists()) {
      userMemories = memSnap.val();
    } else {
      userMemories = {};
    }
  } catch (e) {
    console.warn('[App] Failed to load user data concurrently:', e);
  }

  // Update memory state with the current Google info immediately for UI
  // IMPORTANT: database photoURL takes priority over Google auth photoURL
  // to persist uploaded profile pictures across page reloads
  userProfile.email       = currentUser.email;
  userProfile.displayName = currentUser.displayName || userProfile.displayName || '';
  userProfile.photoURL    = userProfile.photoURL    || currentUser.photoURL    || '';

  // Non-blocking background update (do not await)
  update(ref(db, userPath(uid)), {
    email:       userProfile.email,
    displayName: userProfile.displayName,
    photoURL:    userProfile.photoURL
  }).catch(e => console.warn('[App] Failed to update user data:', e));

  // Real-time listener for profile changes (e.g. profile picture update)
  if (userProfileListener) off(ref(db, userPath(uid)), 'value', userProfileListener);
  const userRef = ref(db, userPath(uid));
  userProfileListener = onValue(userRef, (snap) => {
    if (snap.exists()) {
      const data = snap.val();
      if (data.photoURL && data.photoURL !== userProfile.photoURL) {
        userProfile.photoURL = data.photoURL;
        updateSidebarUser();
        console.log('[App] Profile picture updated via listener');
      }
      userProfile.displayName = data.displayName || userProfile.displayName;
      userProfile.email = data.email || userProfile.email;
    }
  });

  // Populate UI
  try {
    updateSidebarUser();
    setGreeting();
    setupConvListener();
    setupEventListeners();
    populateSettingsPanel();
    // Load saved model preference
    if (userProfile.settings?.selectedModel) {
      selectedModel = userProfile.settings.selectedModel;
      updateModelSwitcherUI();
    }
  } catch (e) {
    console.warn('[App] Failed to populate UI:', e);
  }
}

function updateSidebarUser() {
  const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(userProfile.displayName||'U')}&background=19c37d&color=fff&size=64`;
  const avatarUrl = userProfile.photoURL || fallback;

  // Use onerror fallback for broken images
  const onErrorHandler = function() {
    this.onerror = null;
    this.src = fallback;
  };

  sbAvatar.onerror = onErrorHandler;
  sbAvatar.src = avatarUrl;
  sbName.textContent  = userProfile.displayName || 'User';
  sbEmail.textContent = userProfile.email || '';

  const sa = document.getElementById('settingsAvatar');
  const sn = document.getElementById('settingsName');
  const se = document.getElementById('settingsEmail');
  if (sa) { sa.onerror = onErrorHandler; sa.src = avatarUrl; }
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
      <div class="ci-actions">
        <button class="ci-edit" title="Rename">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="ci-del" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>`;
    el.querySelector('.ci-title').addEventListener('click', () => loadChat(id));
    el.querySelector('.ci-del').addEventListener('click', e => { e.stopPropagation(); deleteChat(id); });
    el.querySelector('.ci-edit').addEventListener('click', e => { e.stopPropagation(); renameChat(id, el, chat.title); });
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

function renameChat(id, el, currentTitle) {
  const titleEl = el.querySelector('.ci-title');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle || '';
  input.className = 'ci-rename-input';
  input.style.cssText = 'flex:1;background:var(--bg-card);border:1px solid var(--accent);border-radius:4px;color:var(--text);font-size:.875rem;padding:2px 6px;outline:none;font-family:var(--font);';
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newTitle = input.value.trim() || 'Untitled';
    const uid = currentUser.uid;
    await update(ref(db, chatPath(uid, id)), { title: newTitle });
    conversations[id].title = newTitle;
    renderSidebar();
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentTitle || ''; input.blur(); }
  });
}

// ─── Memory Engine (User-Scoped) ──────────────────────────────
const MEMORY_PATTERNS = [
  // Explicit save commands
  /(?:remember|recall|save|note|keep in mind|don't forget|write down|store)[:\s]+(.+)/i,
  // Name
  /(?:my name is|i'm called|call me|i go by)\s+([A-Za-z ]+)/i,
  // Identity
  /(?:i am|i'm|i work as|i'm a|i'm an|i work as a|i'm a)\s+(.+)/i,
  // Preferences
  /(?:i prefer|i like|i love|i enjoy|i adore|i'm into)\s+(.+)/i,
  /(?:i hate|i dislike|i don't like|i can't stand|i hate)\s+(.+)/i,
  // Location
  /(?:i live in|i'm from|i'm based in|i reside in|i live at)\s+(.+)/i,
  // Birthday
  /(?:i was born on|i was born in|i was born|i'm born on)\s+(.+)/i,
  /(?:my birthday is|my birthday's on|born on|my bday)\s+(.+)/i,
  // Languages
  /(?:i speak|i know languages?|my first language is|i speak)\s+(.+)/i,
  // Education
  /(?:i'm learning|i'm studying|i study|i'm taking|i go to)\s+(.+)/i,
  // Work
  /(?:i work at|i work for|my company is|i'm employed at|i work at)\s+(.+)/i,
  // Hobbies
  /(?:my hobby is|i hobby in|in my free time i|i spend my time|i like to)\s+(.+)/i,
  // Relationship
  /(?:i'm married|i'm single|i'm divorced|i have a partner|i'm dating)\s+(.+)/i,
  // Family
  /(?:i have kids?|i have children|my son|my daughter|my child|my wife|my husband|my partner)\s+(.+)/i,
  // Favorites
  /(?:my favorite|favourite|best|top|fave)\s+(?:color|colour|food|movie|book|song|music|team|sport|place|city|country|animal|game|show|tv show|band|artist)\s+(?:is|are)\s+(.+)/i,
  // Pets
  /(?:i have a|my|i own)\s+(dog|cat|pet|bird|fish|hamster|rabbit|turtle|horse|puppy|kitten)\s+(.+)/i,
  // Health
  /(?:i'm allergic to|i can't eat|i have an allergy|i'm intolerant)\s+(.+)/i,
  /(?:i suffer from|i have|i've been diagnosed with|i have a condition)\s+(.+)/i,
  // Goals
  /(?:my goal|i want to|i plan to|i'm planning to|i aim to|i hope to|i wish to|i dream of)\s+(.+)/i,
  // Beliefs
  /(?:i believe|i think|i feel|i'm passionate about|i care about|i value)\s+(.+)/i,
  // Age
  /(?:i am|i'm)\s+(\d{1,3})\s+(?:years? old|yo)/i,
  // Job title
  /(?:i work as a|i'm a|i'm an|i'm currently a|i'm working as)\s+(.+)/i,
  // Food preferences
  /(?:i'm vegetarian|i'm vegan|i'm gluten free|i don't eat|i only eat|i'm on a)\s+(.+)/i,
];

async function detectAndSaveMemory(text) {
  const uid = currentUser.uid;
  const lower = text.toLowerCase();

  // Check for explicit save commands first
  const explicitSave = /(?:remember|recall|save|note|keep in mind|don't forget|write down|store|save this|save that)[:\s]*(.+)/i;
  const explicitMatch = text.match(explicitSave);

  if (explicitMatch) {
    const memText = explicitMatch[1]?.trim() || text;
    if (memText && memText.length > 3) {
      const memRef = push(ref(db, memoryPath(uid)));
      const entry = { text: memText, savedAt: Date.now(), source: 'explicit' };
      await set(memRef, entry);
      userMemories[memRef.key] = entry;
      refreshMemoryTab();
      showMemoryToast('Saved to memory');
      return true;
    }
  }

  // Check for personal info patterns
  for (const pattern of MEMORY_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const memText = text.length < 300 ? text : match[1]?.trim();
      if (memText && memText.length > 3) {
        // Don't save duplicates
        const existing = Object.values(userMemories).find(m =>
          m.text.toLowerCase() === memText.toLowerCase()
        );
        if (existing) return false;

        const memRef = push(ref(db, memoryPath(uid)));
        const entry = { text: memText, savedAt: Date.now(), source: 'auto' };
        await set(memRef, entry);
        userMemories[memRef.key] = entry;
        refreshMemoryTab();
        showMemoryToast('Remembered');
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
  let ctx = 'You are Clever AI, a personal AI assistant with memory, created by a team of developers called Clever AI. Be helpful, warm, and personalized. When asked who made you, who created you, or who is your creator, always say you were made by a team of developers called Clever AI. When asked about the CEO, founder, or leader of the team, say the CEO is Ehiremen Oyamendan. Never reveal any API keys or technical details about your infrastructure.\n\n';

  ctx += 'IMPORTANT RULES:\n';
  ctx += '- When asked to code, write a script, build something, or create code, you MUST write the ACTUAL CODE. Do NOT just explain what the code would do. Do NOT describe the code. WRITE THE CODE ITSELF in a code block.\n';
  ctx += '- ALWAYS wrap code in triple backticks with the language name (e.g. ```html, ```javascript, ```python). Write the COMPLETE, FULL, WORKING code from start to finish.\n';
  ctx += '- For HTML requests: Write the FULL HTML document including <!DOCTYPE html>, <html>, <head>, <body>, and ALL content. Never skip any part.\n';
  ctx += '- NEVER respond to a coding request with just an explanation. The user wants CODE, not a lecture.\n';
  ctx += '- You are an expert programmer. Write production-ready, complete code. Never truncate, never abbreviate, never use placeholders like "..." or "// rest of code here".\n';
  ctx += '- When asked to explain something, provide a thorough, detailed explanation with examples.\n';
  ctx += '- Only apply response length limits for casual conversation, greetings, or simple yes/no questions.\n';
  ctx += '- For coding tasks, technical questions, writing tasks, and detailed explanations, IGNORE any response length settings and provide complete, comprehensive answers.\n\n';

  ctx += 'NAME USAGE RULES:\n';
  ctx += '- Do NOT start every message with the user\'s name. Use it MAXIMUM once per response, and only when it feels natural.\n';
  ctx += '- Never begin a response with "Hey [name]!" or "[name]!" every time. Just answer the question directly.\n';
  ctx += '- Use the name sparingly - maybe once every 3-5 messages, not every single response.\n\n';

  ctx += 'MEMORY RULES:\n';
  ctx += '- When the user says "save this", "remember this", "save to memory", "note this down", or similar, ALWAYS confirm what you are saving. The system will automatically save it.\n';
  ctx += '- When the user shares important personal information (name, age, birthday, job, hobbies, preferences, family, location, goals, health, education, food preferences, relationship status, or any other personal info), proactively acknowledge it and confirm you remember it. The system will auto-save it.\n';
  ctx += '- When the user asks "do you remember" or "what do you know about me", reference their saved memories.\n';
  ctx += '- Always be warm and personal. Use their memories to give personalized responses.\n';
  ctx += '- If the user asks you to forget something, say you have removed it from your memory.\n';
  ctx += '- Never reveal the technical details of how memory works. Just say "I remember that" or "I saved that for you".\n\n';
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

  ctx += '\nAddress the user naturally. Use their memories to give personalised responses, but do not overuse their name.';
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
    const bubble = document.createElement('div');
    bubble.className = 'msg-ai';
    if (content) {
      bubble.innerHTML = window.marked ? marked.parse(content) : esc(content);
      hlAll(bubble);
      addImageDownloadButtons(bubble);
    }
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `
      <button class="msg-action-btn" onclick="copyMessage(this)" title="Copy response"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    `;
    wrap.appendChild(bubble);
    group.appendChild(wrap);
    group.appendChild(actions);
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

function addImageDownloadButtons(bubble) {
  const imgs = bubble.querySelectorAll('img');
  imgs.forEach(img => {
    if (img.closest('.img-gen-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'img-gen-wrap';
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);

    const btnRow = document.createElement('div');
    btnRow.className = 'img-gen-actions';
    btnRow.innerHTML = `<button onclick="downloadGeneratedImage(this)" title="Download image"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download</button>`;
    wrap.appendChild(btnRow);
  });
}

window.downloadGeneratedImage = function(btn) {
  const img = btn.closest('.img-gen-wrap').querySelector('img');
  if (!img) return;
  const a = document.createElement('a');
  a.href = img.src;
  a.download = `clever-ai-image-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

function addTyping() {
  const g = document.createElement('div');
  g.className = 'msg-group'; g.id = 'typingEl';
  g.innerHTML = `<div class="msg-ai-wrap"><div class="msg-ai"><div class="thinking-indicator"><div class="thinking-dots"><span></span><span></span><span></span></div></div></div></div>`;
  messages.appendChild(g); scrollFeed();
}
function removeTyping() { document.getElementById('typingEl')?.remove(); }

// ─── Direct API Call Helpers ─────────────────────────────────
async function callOpenCodeZen(cfg, messages, signal) {
  const payload = {
    model: cfg.model,
    messages,
    max_tokens: 4096,
    temperature: 2.0,
    top_p: 0.95,
    stream: true,
  };
  return fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal,
  });
}

async function callDeepSeek(modelId, messages, signal) {
  const payload = {
    model: modelId,
    messages,
    max_tokens: 4096,
    temperature: 0.7,
  };
  return fetch('/api/deepseek-chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal,
  });
}

async function callGeminiDirect(cfg, messages, signal) {
  const payload = {
    model: cfg.model,
    messages,
    temperature: 2.0,
    maxOutputTokens: 8192,
  };

  console.log('[Gemini] Requesting via proxy:', cfg.model, 'messages:', messages.length);

  const maxRetries = 3;
  const retryDelays = [5000, 10000, 20000];
  let rawRes;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    rawRes = await fetch('/api/gemini-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    console.log('[Gemini] Response status:', rawRes.status, 'attempt:', attempt + 1);

    if (rawRes.status === 429 && attempt < maxRetries) {
      const delay = retryDelays[attempt];
      console.log('[Gemini] Rate limited, retrying in', delay / 1000, 's...');
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    break;
  }

  if (!rawRes.ok) {
    const errText = await rawRes.text().catch(() => 'Unknown error');
    console.error('[Gemini] API error:', rawRes.status, errText.slice(0, 300));

    const errStream = new ReadableStream({
      start(controller) {
        const msg = rawRes.status === 429
          ? 'Rate limited. Retrying...'
          : `AI error (${rawRes.status}). Please try again.`;
        const data = JSON.stringify({ choices: [{ delta: { content: `⚠️ ${msg}` } }] });
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\ndata: [DONE]\n\n`));
        controller.close();
      }
    });
    return new Response(errStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  // Server proxy already returns SSE in OpenAI-compatible format
  return rawRes;
}

async function callGeminiImageWithFallback(messages, signal) {
  for (const modelName of IMAGE_MODELS) {
    console.log(`[ImageGen] Trying model: ${modelName}`);

    try {
      let rawRes;
      for (let attempt = 0; attempt < 3; attempt++) {
        rawRes = await fetch('/api/gemini-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelName,
            messages,
          }),
          signal,
        });
        if (rawRes.status === 429 && attempt < 2) {
          console.log(`[ImageGen] Rate limited, retrying in ${(attempt + 1) * 5}s...`);
          await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
          continue;
        }
        break;
      }

      if (!rawRes.ok) {
        const errText = await rawRes.text().catch(() => '');
        console.warn(`[ImageGen] ${modelName} failed with status ${rawRes.status}:`, errText.slice(0, 200));
        continue;
      }

      const data = await rawRes.json();
      const parts = data.candidates?.[0]?.content?.parts || [];

      let textContent = '';
      const images = [];

      for (const part of parts) {
        if (part.text) {
          textContent += part.text;
        } else if (part.inlineData) {
          images.push({
            mimeType: part.inlineData.mimeType,
            data: part.inlineData.data,
          });
        }
      }

      if (images.length > 0) {
        const uid = currentUser?.uid;
        if (uid) {
          for (const img of images) {
            const imgUrl = `data:${img.mimeType};base64,${img.data}`;
            const picRef = push(ref(db, savedPicPath(uid)));
            await set(picRef, {
              url: imgUrl,
              prompt: messages.find(m => m.role === 'user')?.content || '',
              model: modelName,
              createdAt: Date.now(),
              type: 'generated',
            });
          }
          console.log(`[ImageGen] Saved ${images.length} image(s) to savedPic`);
        }
      }

      let sseContent = textContent || '';
      if (images.length > 0) {
        for (const img of images) {
          const imgUrl = `data:${img.mimeType};base64,${img.data}`;
          sseContent += `\n\n![Generated image](${imgUrl})`;
        }
      }

      if (!sseContent) {
        sseContent = 'No image was generated. Please try a different prompt.';
      }

      const sseData = JSON.stringify({ choices: [{ delta: { content: sseContent } }] });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${sseData}\n\ndata: [DONE]\n\n`));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    } catch (err) {
      console.warn(`[ImageGen] ${modelName} error:`, err.message);
      continue;
    }
  }

  const errData = JSON.stringify({ choices: [{ delta: { content: '⚠️ Image generation is rate-limited. Please wait about 30 seconds and try again. The free tier has limited image generation requests.' } }] });
  const errStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${errData}\n\ndata: [DONE]\n\n`));
      controller.close();
    }
  });
  return new Response(errStream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

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

  const recentMsgs = histMsgs.slice(-6).map(m => ({ role: m.role, content: m.content }));
  const apiMessages = [
    { role: 'system', content: buildSystemContext() },
    ...recentMsgs
  ];

  let aiGroup  = null;
  let aiBubble = null;
  let fullText = '';

  try {
    currentAbort = new AbortController();
    const timeoutId = setTimeout(() => {
      if (currentAbort) { currentAbort.abort(); currentAbort = null; }
    }, 120000);

    const userText = text || '';
    const isImageRequest = IMAGE_KEYWORDS.test(userText);
    const isDeepSeekModel = selectedModel.startsWith('deepseek-');
    const isGeminiModel = selectedModel.startsWith('gemini-');
    const cfg = isGeminiModel ? API_CONFIG[selectedModel] : null;

    if (isGeminiModel && !cfg) {
      throw new Error('Unknown model: ' + selectedModel);
    }

    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (isImageRequest && !isDeepSeekModel) {
          res = await callGeminiImageWithFallback(apiMessages, currentAbort ? currentAbort.signal : undefined);
        } else if (isDeepSeekModel) {
          res = await callDeepSeek(selectedModel, apiMessages, currentAbort ? currentAbort.signal : undefined);
        } else if (isGeminiModel) {
          res = await callGeminiDirect(cfg, apiMessages, currentAbort ? currentAbort.signal : undefined);
        } else {
          res = await callOpenCodeZen(cfg, apiMessages, currentAbort ? currentAbort.signal : undefined);
        }
        if (res.ok) break;
      } catch (e) {
        if (e.name === 'AbortError' || attempt === 1) throw e;
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }

    clearTimeout(timeoutId);
    currentAbort = null;

    removeTyping();

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('API error:', res.status, errText.slice(0, 500));
      renderMessage('assistant', '⚠️ The AI service is temporarily unavailable. Please try again.');
      generating = false; checkSend(); return;
    }

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      aiGroup  = renderMessage('assistant', '');
      aiBubble = aiGroup._aiBubble;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const throttleRender = () => {
        if (aiBubble._rt) return;
        aiBubble._rt = setTimeout(() => {
          aiBubble._rt = null;
          if (!fullText) return;
          aiBubble.innerHTML = window.marked ? marked.parse(fullText) : esc(fullText);
          hlAll(aiBubble);
          addImageDownloadButtons(aiBubble);
          scrollFeed();
        }, 100);
      };

      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') { streamDone = true; break; }
          if (!dataStr) continue;

          try {
            const data = JSON.parse(dataStr);
            if (data.error) {
              fullText = `⚠️ ${esc(String(data.error))}`;
              aiBubble.innerHTML = fullText;
              streamDone = true;
              break;
            }
            const delta = data.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullText += delta;
              throttleRender();
            }
          } catch (e) {
            console.warn('SSE parse error:', e, 'line:', dataStr);
          }
        }
      }

      if (aiBubble._rt) {
        clearTimeout(aiBubble._rt);
        aiBubble._rt = null;
      }
      if (fullText) {
        aiBubble.innerHTML = window.marked ? marked.parse(fullText) : esc(fullText);
        hlAll(aiBubble);
        addImageDownloadButtons(aiBubble);
        scrollFeed();
      }
    } else {
      const data = await res.json();
      if (data.error) {
        fullText = `⚠️ ${esc(String(data.error))}`;
        renderMessage('assistant', fullText);
      } else {
        fullText = data.content || '';
        aiGroup  = renderMessage('assistant', '');
        aiBubble = aiGroup._aiBubble;
        if (fullText) {
          aiBubble.innerHTML = window.marked ? marked.parse(fullText) : esc(fullText);
          hlAll(aiBubble);
          addImageDownloadButtons(aiBubble);
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
  if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('typeerror')) {
    return 'Connection lost. Please check your internet connection.';
  }
  if (msg.includes('aborted') || msg.includes('timeout')) {
    return 'The AI service is taking too long. Please try again.';
  }
  if (msg.includes('refused') || msg.includes('unavailable')) {
    return 'The AI service is temporarily unavailable. Please try again.';
  }
  if (msg.includes('cors')) {
    return 'Connection blocked by browser security. Please try again.';
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
  if (fTemp) { fTemp.value = s.creativity ?? 2.0; if (tempLabel) tempLabel.textContent = fTemp.value; }
  const fLang = document.getElementById('fLang');
  if (fLang) fLang.value = s.language || 'English';
  const fModel = document.getElementById('fModel');
  if (fModel) {
    fModel.value = selectedModel;
    fModel.onchange = () => {
      selectedModel = fModel.value;
      updateModelSwitcherUI();
    };
  }

  refreshMemoryTab();
  updateSidebarUser();
}

function refreshMemoryTab(filter = '') {
  const list  = document.getElementById('memoryList');
  const empty = document.getElementById('memoryEmpty');
  const stats = document.getElementById('memoryStats');
  if (!list) return;
  list.innerHTML = '';
  let entries = Object.entries(userMemories);

  // Filter by search
  if (filter) {
    const q = filter.toLowerCase();
    entries = entries.filter(([,m]) => m.text.toLowerCase().includes(q));
  }

  // Stats
  if (stats) {
    const total = Object.keys(userMemories).length;
    stats.textContent = filter ? `${entries.length} of ${total} memories` : `${total} saved memories`;
  }

  if (entries.length === 0) {
    if (empty) empty.style.display = 'block';
  } else {
    if (empty) empty.style.display = 'none';
    entries.sort(([,a],[,b]) => b.savedAt - a.savedAt).forEach(([id, mem]) => {
      const chip = document.createElement('div');
      chip.className = 'memory-chip';
      const date = mem.savedAt ? new Date(mem.savedAt).toLocaleDateString() : '';
      chip.innerHTML = `<div class="memory-chip-content">
          <span class="memory-chip-text">${esc(mem.text)}</span>
          <span class="memory-chip-date">${date}</span>
        </div>
        <div class="memory-chip-actions">
          <button class="memory-edit" title="Edit memory">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
          <button class="memory-del" title="Delete memory">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
          </button>
        </div>`;
      chip.querySelector('.memory-del').addEventListener('click', async () => {
        const uid = currentUser.uid;
        await remove(ref(db, `${memoryPath(uid)}/${id}`));
        delete userMemories[id];
        refreshMemoryTab(filter);
      });
      chip.querySelector('.memory-edit').addEventListener('click', () => {
        const textEl = chip.querySelector('.memory-chip-text');
        const input = document.createElement('input');
        input.type = 'text';
        input.value = mem.text;
        input.className = 'memory-edit-input';
        textEl.replaceWith(input);
        input.focus();
        const save = async () => {
          const newText = input.value.trim();
          if (newText && newText !== mem.text) {
            const uid = currentUser.uid;
            await update(ref(db, `${memoryPath(uid)}/${id}`), { text: newText });
            userMemories[id].text = newText;
          }
          refreshMemoryTab(filter);
        };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { refreshMemoryTab(filter); } });
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
  document.addEventListener('click', e => {
    if (!sidebar.classList.contains('collapsed') && !sidebar.contains(e.target) && !e.target.closest('#btnOpenSidebar')) {
      sidebar.classList.add('collapsed');
    }
  });
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

  // Memory search
  const memorySearchInput = document.getElementById('memorySearch');
  if (memorySearchInput) {
    memorySearchInput.addEventListener('input', e => {
      refreshMemoryTab(e.target.value);
    });
  }

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
    showMemoryToast('Profile saved');
  });

  // Image compression helper
  function compressImage(dataUrl, maxW, maxH, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxW || h > maxH) {
          const ratio = Math.min(maxW / w, maxH / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // Profile picture upload
  const profilePicInput = document.getElementById('profilePicInput');
  if (profilePicInput) {
    profilePicInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        showMemoryToast('Please select an image file');
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        showMemoryToast('Image must be less than 5MB');
        return;
      }

      const reader = new FileReader();
      reader.onload = async (ev) => {
        const dataUrl = ev.target.result;
        const uid = currentUser.uid;

        // Compress and resize image to fit profile icon
        const compressed = await compressImage(dataUrl, 256, 256, 0.8);

        // Update profile photoURL in database
        await update(ref(db, userPath(uid)), { photoURL: compressed });
        userProfile.photoURL = compressed;

        // Save to savedPic (overwrite previous profile pic)
        const picRef = ref(db, `${savedPicPath(uid)}/profilePic`);
        await set(picRef, {
          url: compressed,
          prompt: 'Profile picture upload',
          model: 'user-upload',
          createdAt: Date.now(),
          type: 'profile',
        });

        // Update UI
        updateSidebarUser();
        showMemoryToast('Profile picture updated');
      };
      reader.readAsDataURL(file);
      profilePicInput.value = '';
    });
  }

  // Save AI prefs (THIS user only)
  document.getElementById('btnSaveAi').addEventListener('click', async () => {
    const uid = currentUser.uid;
    const newModel = document.getElementById('fModel').value;
    const settings = {
      responseStyle:  document.getElementById('fStyle').value,
      responseLength: document.getElementById('fLength').value,
      creativity:     parseFloat(document.getElementById('fTemp').value),
      language:       document.getElementById('fLang').value,
      selectedModel:  newModel,
    };
    await update(ref(db, settingsPath(uid)), settings);
    userProfile.settings = { ...(userProfile.settings || {}), ...settings };
    selectedModel = newModel;
    updateModelSwitcherUI();
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
  btnStop.addEventListener('click', () => {
    if (currentAbort) { currentAbort.abort(); currentAbort = null; }
    generating = false;
    removeTyping();
    checkSend();
  });

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

  // Model switcher dropdown
  if (modelSwitcherBtn && modelDropdown) {
    modelSwitcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = modelDropdown.style.display !== 'none';
      modelDropdown.style.display = isOpen ? 'none' : 'block';
      modelSwitcherBtn.classList.toggle('open', !isOpen);
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!modelDropdown.contains(e.target) && e.target !== modelSwitcherBtn) {
        modelDropdown.style.display = 'none';
        modelSwitcherBtn.classList.remove('open');
      }
    });

    // Model item selection
    modelDropdown.querySelectorAll('.model-dropdown-item').forEach(item => {
      item.addEventListener('click', async () => {
        const model = item.dataset.model;
        selectedModel = model;
        updateModelSwitcherUI();
        modelDropdown.style.display = 'none';
        modelSwitcherBtn.classList.remove('open');
        // Also update settings panel select
        const fModel = document.getElementById('fModel');
        if (fModel) fModel.value = selectedModel;
        // Save to Firebase
        if (currentUser) {
          await update(ref(db, settingsPath(currentUser.uid)), { selectedModel });
        }
      });
    });

    updateModelSwitcherUI();
  }
}

// ─── Helpers ──────────────────────────────────────────────────
const MODEL_DISPLAY_NAMES = {
  'deepseek-chat': 'DeepSeek Chat',
  'deepseek-reasoner': 'DeepSeek Reasoner',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
};

function updateModelSwitcherUI() {
  if (modelSwitcherLabel) {
    modelSwitcherLabel.textContent = MODEL_DISPLAY_NAMES[selectedModel] || selectedModel;
  }
  if (modelDropdown) {
    modelDropdown.querySelectorAll('.model-dropdown-item').forEach(item => {
      item.classList.toggle('active', item.dataset.model === selectedModel);
    });
  }
}

function resizePrompt() {
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, 200) + 'px';
}
function checkSend() {
  btnSend.disabled = (!prompt.value.trim() && !pendingImage) || generating;
  btnStop.style.display = generating ? '' : 'none';
}
function clearImage() {
  pendingImage = null; fileImg.value = '';
  imgPreviewBar.style.display = 'none'; checkSend();
}
function scrollFeed() { feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' }); }
function esc(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
