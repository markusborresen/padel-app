// app.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { getFirestore, doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

// LIM INN firebaseConfig HER (fra Firebase Console)
const firebaseConfig = {
  apiKey: "AIzaSyC9fFogpchL6vJbia2s5hh60v8Xie5-kfA",
  authDomain: "padel-plan-3668b.firebaseapp.com",
  projectId: "padel-plan-3668b",
  storageBucket: "padel-plan-3668b.firebasestorage.app",
  messagingSenderId: "553858373608",
  appId: "1:553858373608:web:a98772c1412ee0b576365d",
  measurementId: "G-WS6EL0FWGN"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

async function main() {
  // 1) Login anonymt
  await signInAnonymously(auth);

  // 2) Skriv et testdokument
  const id = "test-" + Date.now();
  await setDoc(doc(db, "sessions", id), {
    hello: "world",
    createdAt: serverTimestamp()
  });

  console.log("✅ Firestore write OK:", id);
  document.body.insertAdjacentHTML("beforeend", `<p>✅ Firestore write OK: ${id}</p>`);
}

main().catch(err => {
  console.error("❌ Firebase test failed:", err);
  document.body.insertAdjacentHTML("beforeend", `<p>❌ Firebase test failed: ${err?.message || err}</p>`);
});
