import { auth, db, googleProvider } from './firebase.js';
import {
  onAuthStateChanged,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  ref, get, set, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const btnGoogle  = document.getElementById('btnGoogle');
const authError  = document.getElementById('authError');
const authLoader = document.getElementById('authLoader');

// If already logged in → go straight to app
onAuthStateChanged(auth, user => {
  if (user) {
    window.location.replace('/');
  }
});

function showError(msg) {
  authError.textContent = msg;
  authError.style.display = 'block';
}

function showLoader(on) {
  authLoader.style.display = on ? 'flex' : 'none';
  btnGoogle.disabled = on;
}

btnGoogle.addEventListener('click', async () => {
  authError.style.display = 'none';
  showLoader(true);

  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user   = result.user;
    const uid    = user.uid;

    // Check if user record already exists
    const userRef = ref(db, `users/${uid}`);
    const snap    = await get(userRef);

    if (!snap.exists()) {
      // Create complete user structure for new users
      // Database structure:
      // users/{uid}/
      //   ├── email
      //   ├── displayName
      //   ├── photoURL
      //   ├── dateOfBirth
      //   ├── gender
      //   ├── bio
      //   ├── location
      //   ├── occupation
      //   ├── createdAt
      //   ├── memory/          (empty - user's private memory store)
      //   ├── chatDatabase/    (empty - user's private chat history)
      //   └── settings/        (default AI preferences)
      await set(userRef, {
        // Profile information
        email:       user.email || '',
        displayName: user.displayName || '',
        photoURL:    user.photoURL || '',
        dateOfBirth: '',
        gender:      '',
        bio:         '',
        location:    '',
        occupation:  '',
        createdAt:   Date.now(),

        // User's private memory store (empty by default)
        memory: {},

        // User's private chat database (empty by default)
        chatDatabase: {},

        // Default AI settings
        settings: {
          responseStyle:  'balanced',
          responseLength: 'medium',
          creativity:     1.0,
          language:       'English'
        }
      });

      console.log(`[Auth] New user created: ${uid} (${user.email})`);
    } else {
      console.log(`[Auth] Existing user signed in: ${uid} (${user.email})`);

      // Ensure new structure fields exist for existing users (migration)
      const updates = {};
      const userData = snap.val();

      // Migrate savedMemory to memory if needed
      if (userData.savedMemory && !userData.memory) {
        updates.memory = userData.savedMemory;
      }

      // Ensure memory and chatDatabase exist
      if (!userData.memory) updates.memory = {};
      if (!userData.chatDatabase) updates.chatDatabase = {};
      if (!userData.settings) {
        updates.settings = {
          responseStyle:  'balanced',
          responseLength: 'medium',
          creativity:     1.0,
          language:       'English'
        };
      }

      if (Object.keys(updates).length > 0) {
        await set(ref(db, `users/${uid}`), { ...userData, ...updates });
        console.log(`[Auth] User data migrated for: ${uid}`);
      }
    }

    // Redirect to main app
    window.location.replace('/');

  } catch (err) {
    console.error('[Auth] Sign-in error:', err);
    if (err.code === 'auth/popup-closed-by-user') {
      showError('Sign-in cancelled. Please try again.');
    } else if (err.code === 'auth/network-request-failed') {
      showError('Network error. Check your connection.');
    } else if (err.code === 'auth/cancelled-popup-request') {
      showError('Sign-in was cancelled. Please try again.');
    } else if (err.code === 'auth/account-exists-with-different-credential') {
      showError('An account already exists with a different sign-in method.');
    } else {
      showError('Sign-in failed. Please try again.');
    }
    showLoader(false);
  }
});
