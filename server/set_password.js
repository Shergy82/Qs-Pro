// Usage: node set_password.js <email>
// Prompts for a new password (hidden) and updates that user in Firestore.
require('dotenv').config();
const { firestore } = require('./firestore');
const { hashPassword } = require('./database');

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node set_password.js <email>');
    process.exit(1);
  }
  const snap = await firestore.collection('users').where('email', '==', email).limit(1).get();
  if (snap.empty) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }
  const password = await askHidden('New password (min 8 chars): ');
  if (password.length < 8) {
    console.error('Password too short.');
    process.exit(1);
  }
  const { salt, hash } = hashPassword(password);
  await snap.docs[0].ref.update({ password_hash: hash, salt });
  console.log(`Password updated for ${email}. Existing sessions stay valid until they expire.`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
