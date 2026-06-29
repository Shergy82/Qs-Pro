const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!getApps().length) {
  initializeApp();
}

const firestore = getFirestore();

module.exports = {
  firestore
};
