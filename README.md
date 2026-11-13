# Connect — messaging and calling website

This is a GitHub Pages front end with Firebase providing accounts, chat storage,
presence, and WebRTC call signaling. It includes private chats, group chats,
saved contacts, audio/video controls, and a dark/light theme.

## Important limitations

- GitHub Pages is static hosting; Firebase is required for shared accounts and messages.
- Calls use WebRTC peer-to-peer connections and a public STUN server. Some networks
  require a TURN service for reliable calls. Add your own TURN credentials before
  using this with a wider audience.
- The included calling code is an initial small-group mesh implementation. Keep
  group calls small (2–4 participants); a production service should use a managed
  SFU, stronger call invitations, and more complete reconnection handling.
- This starter is not a fully audited production service. Add moderation, rate limits,
  account recovery, email verification, abuse reporting, and privacy/legal pages
  before opening it to the public.

## 1. Create and configure Firebase

1. Go to https://console.firebase.google.com/ and create a project.
2. Add a Web App and copy its config into `firebase-config.js`.
3. In **Authentication → Sign-in method**, enable **Email/Password**.
4. Create a **Cloud Firestore** database.
5. Create a **Realtime Database**.
6. In Firestore → Rules, paste `firestore.rules` and publish.
7. In Realtime Database → Rules, paste `database.rules.json` and publish.
8. In Authentication settings, add your GitHub Pages domain to Authorized domains.

The Firebase web config is not a password or server secret. Never put service-account
keys or private credentials in this website.

## 2. Publish on GitHub Pages

1. Create a public GitHub repository, for example `connect-chat`.
2. Upload `index.html`, `styles.css`, `app.js`, `firebase-config.js`, and the rules/readme.
3. Open repository **Settings → Pages**.
4. Under Build and deployment, choose **Deploy from a branch**.
5. Choose `main` and `/ (root)`, then Save.
6. Open the Pages URL after deployment.

Use the HTTPS GitHub Pages URL. Camera and microphone permissions require a secure
context (HTTPS or localhost).

## 3. Test with two accounts

1. Open the site and create an account with a unique username, email, and password.
2. Open the Pages URL in a private/incognito window or another device and create a
   second account.
3. Add the other account by exact username.
4. Start a private chat or create a group using comma-separated usernames.
5. Allow camera/microphone permissions to test a call.

## 4. Before public launch

- Add a TURN server and configure its credentials in `app.js` under `iceServers`.
- Replace browser `confirm()` call prompts with an in-app incoming-call screen.
- Add block/report tools and moderation workflows.
- Add rate limiting (for example with Firebase App Check and trusted backend functions).
- Add email verification, password reset, account deletion, and privacy/terms pages.
- Review Firestore and Realtime Database rules with a security professional.
- Consider a WebRTC SFU provider for larger group calls.

## Files

- `index.html` — app structure
- `styles.css` — responsive dark/light interface
- `app.js` — authentication, chats, contacts, groups, and call signaling
- `firebase-config.js` — your Firebase web app configuration
- `firestore.rules` — Firestore access rules
- `database.rules.json` — Realtime Database rules
