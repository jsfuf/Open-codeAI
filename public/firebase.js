// ─── Firebase Configuration ────────────────────────────────────
// Shared across auth.js and app.js via script tag in HTML

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfig = {
  apiKey:            "AIzaSyBm4CaabVaNSS0wKlCQQehrl9hBTmRZRHY",
  authDomain:        "ai-chat-21dfc.firebaseapp.com",
  databaseURL:       "https://ai-chat-21dfc-default-rtdb.firebaseio.com",
  projectId:         "ai-chat-21dfc",
  storageBucket:     "ai-chat-21dfc.firebasestorage.app",
  messagingSenderId: "735715660717",
  appId:             "1:735715660717:web:df8896525a863e0c8d4724",
  measurementId:     "G-Y3K4NML4GN"
};

const app      = initializeApp(firebaseConfig);
const auth     = getAuth(app);
const db       = getDatabase(app);
const googleProvider = new GoogleAuthProvider();

googleProvider.addScope('profile');
googleProvider.addScope('email');

export { auth, db, googleProvider };
