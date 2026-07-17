// Paste your Firebase web app config here.
// Firebase console → Project settings → General → Your apps → SDK setup and configuration
export const firebaseConfig = {
  apiKey: "AIzaSyCvAh3Jvgdh1ft1OrPbFwcJaHQkAuJBUEc",
  authDomain: "stocks-26371.firebaseapp.com",
  projectId: "stocks-26371",
  storageBucket: "stocks-26371.firebasestorage.app",
  messagingSenderId: "815404976939",
  appId: "1:815404976939:web:0c3cab1d36ef529053136e",
  measurementId: "G-PW62B1XJT8"
};

// Your Firebase Auth user ID. Only this account sees the Admin tab and can
// create/resolve predictions. Find it on the Predictions page after signing in
// (shown at the bottom until this is set), or in Firebase console → Authentication.
// IMPORTANT: paste the same UID into firestore.rules and republish the rules.
export const ADMIN_UID = "FfORyqwqoMYrmC9iAy8xYQevprG3";
