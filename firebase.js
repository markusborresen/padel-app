import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
  getFirestore, doc, collection
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC9fFogpchL6vJbia2s5hh60v8Xie5-kfA",
  authDomain: "padel-plan-3668b.firebaseapp.com",
  projectId: "padel-plan-3668b",
  storageBucket: "padel-plan-3668b.firebasestorage.app",
  messagingSenderId: "553858373608",
  appId: "1:553858373608:web:a98772c1412ee0b576365d"
};

const fbApp = initializeApp(firebaseConfig);
export const auth = getAuth(fbApp);
export const db = getFirestore(fbApp);
export const firebaseReady = signInAnonymously(auth);

/* ===== Helpers ===== */
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function getDocIdFromPin(pin) {
  const hex = await sha256Hex(`padel|${pin}`);
  return hex.slice(0, 24);
}

export function sessionRef(docId) {
  return doc(db, "sessions", docId);
}

export function historyCol() {
  return collection(db, "history");
}

export function generatePin6() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}
