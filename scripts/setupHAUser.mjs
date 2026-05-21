import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, setDoc } from 'firebase/firestore';

const app = initializeApp({ apiKey: 'fake', authDomain: 'localhost', projectId: 'radtach' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);

const cred = await signInWithEmailAndPassword(auth, 'ha@test.radtach.com', 'Test123!');
const uid = cred.user.uid;
console.log('HA UID:', uid);

await setDoc(doc(db, 'users', uid), {
  email: 'ha@test.radtach.com',
  firstName: 'Hospital',
  lastName: 'Admin',
  timezone: 'America/Chicago',
  createdAt: new Date().toISOString(),
});
console.log('Profile created');

await setDoc(doc(db, 'users', uid, 'settings', 'current'), {
  currentSystem: 'Test System',
});
console.log('Settings created with system = Test System');

console.log('Done. Login as ha@test.radtach.com / Test123!');
process.exit(0);
