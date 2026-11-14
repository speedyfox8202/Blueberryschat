import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc,
  query, where, orderBy, onSnapshot, serverTimestamp, getDocs,
  arrayUnion, arrayRemove, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getDatabase, ref, set, push, onValue, onChildAdded, remove,
  onDisconnect, update
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

const $ = (id) => document.getElementById(id);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);

let currentUser = null, profile = null, activeChat = null;
let isSignup = false, stopChats = null, stopMessages = null, stopContacts = null;
let localStream = null, peerConnections = new Map(), callRoom = null;
let callListeners = [], callId = null, isCaller = false;
let toastTimer;
const ADMIN_UIDS = {
  console: "Vmqgoi0Yr2Y2v5kGL42ZXRONfnb2",
  owner: "Q45h3qgZKLPR0dH6p6fybTxSFU32"
};
const REPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let stopReports = null, stopAnnouncements = null, stopAdminChats = null;
let adminView = "reports";

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2800);
}
function safeText(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function initials(name) { return (name || "?").trim().slice(0, 1).toUpperCase(); }
function showError(id, message) { $(id).textContent = message || ""; }
function showApp(yes) { $("authView").classList.toggle("hidden", yes); $("appView").classList.toggle("hidden", !yes); }
function chatTitle(chat) { if (chat.type === "group") return chat.name; const uid = chat.members.find(memberUid => memberUid !== currentUser.uid); return displayName(chat.memberNames?.[uid] || "Private chat", uid); }
function roleFor(uid) { return uid === ADMIN_UIDS.console ? "console" : uid === ADMIN_UIDS.owner ? "owner" : "user"; }
function isAdmin(uid=currentUser?.uid) { return roleFor(uid) !== "user"; }
function displayName(name, uid) { return roleFor(uid) === "console" ? "Console" : roleFor(uid) === "owner" ? "Owner" : (name || "Member"); }
function roleClass(uid) { const role = roleFor(uid); return role === "user" ? "" : ` role-${role}`; }
function showNormalChat() {
  $("welcomePanel").classList.remove("hidden");
  $("messagesPanel").classList.add("hidden");
  $("adminWorkspace").classList.add("hidden");
  activeChat = null;
}
function showAdminWorkspace(view) {
  adminView = view;
  stopMessages?.(); stopMessages = null;
  activeChat = null;
  $("welcomePanel").classList.add("hidden");
  $("messagesPanel").classList.add("hidden");
  $("adminWorkspace").classList.remove("hidden");
  document.querySelectorAll("[data-admin-view]").forEach(b => b.classList.toggle("active", b.dataset.adminView === view));
  if (view === "reports") renderReports();
  if (view === "chats") renderAdminChats();
  if (view === "announcements") renderAnnouncementForm();
}

$("showLogin").addEventListener("click", () => setAuthMode(false));
$("showSignup").addEventListener("click", () => setAuthMode(true));
function setAuthMode(signup) {
  isSignup = signup;
  $("showLogin").classList.toggle("active", !signup);
  $("showSignup").classList.toggle("active", signup);
  $("usernameLabel").classList.toggle("hidden", !signup);
  $("authSubmit").textContent = signup ? "Create account" : "Sign in";
  $("passwordInput").autocomplete = signup ? "new-password" : "current-password";
  showError("authError", "");
}
$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  showError("authError", "");
  const email = $("emailInput").value.trim().toLowerCase();
  const password = $("passwordInput").value;
  const username = $("usernameInput").value.trim();
  try {
    if (isSignup) {
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new Error("Username must be 3–24 characters (letters, numbers, underscores).");
      if (["owner", "console"].includes(username.toLowerCase())) throw new Error("That username is reserved.");
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(credential.user, { displayName: username });
      await setDoc(doc(db, "users", credential.user.uid), {
        uid: credential.user.uid, username, usernameLower: username.toLowerCase(),
        email, createdAt: serverTimestamp(), contacts: []
      });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (err) { showError("authError", friendlyError(err)); }
});
function friendlyError(err) {
  const messages = {
    "auth/email-already-in-use":"That email already has an account.",
    "auth/invalid-email":"Enter a valid email address.",
    "auth/weak-password":"Choose a stronger password (at least 8 characters).",
    "auth/invalid-credential":"Email or password is incorrect.",
    "auth/too-many-requests":"Too many attempts. Try again later.",
    "auth/network-request-failed":"Network error. Check your connection."
  };
  return messages[err.code] || err.message || "Something went wrong.";
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    cleanupSubscriptions();
    currentUser = null; profile = null; activeChat = null;
    showApp(false); return;
  }
  currentUser = user;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) throw new Error("Your profile could not be found.");
    profile = snap.data();
    if (profile.banned === true) throw new Error("This account has been banned from Connect.");
    const role = roleFor(user.uid);
    $("myName").textContent = displayName(profile.username, user.uid);
    $("myName").className = roleClass(user.uid).trim();
    $("myAvatar").textContent = initials(profile.username);
    showApp(true);
    setPresence();
    listenChats();
    listenContacts();
    setupModeration();
    setupAdminNavigation();
  } catch (err) { toast(err.message); await signOut(auth); }
});

function setPresence() {
  const presenceRef = ref(rtdb, `status/${currentUser.uid}`);
  onDisconnect(presenceRef).set({ state: "offline", lastChanged: Date.now() });
  set(presenceRef, { state: "online", lastChanged: Date.now() });
}
function cleanupSubscriptions() {
  stopChats?.(); stopMessages?.(); stopContacts?.(); stopReports?.(); stopAnnouncements?.(); stopAdminChats?.();
  stopChats = stopMessages = stopContacts = stopReports = stopAnnouncements = stopAdminChats = null;
}
$("signOutButton").addEventListener("click", async () => {
  if (currentUser) await set(ref(rtdb, `status/${currentUser.uid}`), { state: "offline", lastChanged: Date.now() });
  await endCall(false);
  await signOut(auth);
});

function listenChats() {
  stopChats?.();
  const q = query(collection(db, "chats"), where("members", "array-contains", currentUser.uid));
  stopChats = onSnapshot(q, snap => {
    const chats = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    chats.sort((a,b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
    $("chatList").innerHTML = "";
    chats.forEach(chat => {
      const button = document.createElement("button");
      button.className = "chat-item" + (activeChat?.id === chat.id ? " selected" : "");
      const peerUid = chat.type === "group" ? null : chat.members.find(uid => uid !== currentUser.uid);
      button.innerHTML = `<span class="avatar">${safeText(initials(chatTitle(chat)))}</span><span class="chat-item-copy"><strong class="${roleClass(peerUid).trim()}">${safeText(chatTitle(chat))}</strong><small>${chat.type === "group" ? `${chat.members.length} members` : "Private conversation"}</small></span>`;
      button.addEventListener("click", () => openChat(chat));
      $("chatList").append(button);
    });
    if (activeChat) {
      const refreshed = chats.find(c => c.id === activeChat.id);
      if (refreshed) activeChat = refreshed;
    }
  }, err => toast("Could not load chats: " + err.message));
}
function listenContacts() {
  stopContacts?.();
  stopContacts = onSnapshot(doc(db, "users", currentUser.uid), async snap => {
    if (!snap.exists()) return;
    profile = snap.data();
    if (profile.banned === true) {
      toast("This account has been banned from Connect.");
      await set(ref(rtdb, `status/${currentUser.uid}`), { state:"offline", lastChanged:Date.now() }).catch(()=>{});
      await signOut(auth); return;
    }
    const ids = profile.contacts || [];
    $("contactList").innerHTML = "";
    if (!ids.length) {
      $("contactList").innerHTML = `<p class="tiny muted empty-small">No contacts yet.</p>`;
      return;
    }
    for (const uid of ids) {
      const userSnap = await getDoc(doc(db, "users", uid));
      if (!userSnap.exists()) continue;
      const person = userSnap.data();
      const button = document.createElement("button");
      button.className = "contact-item";
      button.innerHTML = `<span class="avatar">${safeText(initials(displayName(person.username, uid)))}</span><span class="${roleClass(uid).trim()}">${safeText(displayName(person.username, uid))}</span>`;
      button.addEventListener("click", () => showPersonActions(uid, displayName(person.username, uid), null));
      $("contactList").append(button);
    }
  });
}

function openChat(chat) {
  activeChat = chat;
  $("adminWorkspace").classList.add("hidden");
  $("welcomePanel").classList.add("hidden");
  $("messagesPanel").classList.remove("hidden");
  const peerUid = chat.type === "group" ? null : chat.members.find(uid => uid !== currentUser.uid);
  $("chatHeader").innerHTML = `<div class="header-person"><div class="avatar">${safeText(initials(chatTitle(chat)))}</div><div><strong class="${roleClass(peerUid).trim()}">${safeText(chatTitle(chat))}</strong><p class="muted tiny">${chat.type === "group" ? `${chat.members.length} members` : "Private conversation"}</p></div></div><div class="header-actions">${chat.type === "group" ? `<button id="groupInfoButton" class="secondary">Group info</button>` : ""}<button id="callButton" class="secondary">▣ Call</button></div>`;
  $("callButton").addEventListener("click", () => startCall());
  $("groupInfoButton")?.addEventListener("click", showGroupInfo);
  listenMessages(chat);
  listenChats();
}
function listenMessages(chat) {
  stopMessages?.();
  const q = query(collection(db, "chats", chat.id, "messages"), orderBy("createdAt", "asc"));
  stopMessages = onSnapshot(q, snap => {
    $("messages").innerHTML = "";
    snap.docs.forEach(d => {
      const m = d.data();
      const own = m.senderId === currentUser.uid;
      const item = document.createElement("div");
      item.className = "message-row " + (own ? "own" : "");
      const senderLabel = displayName(m.senderName, m.senderId);
      const who = `<button class="message-author${roleClass(m.senderId)}" data-user-id="${safeText(m.senderId)}" type="button">${safeText(senderLabel)}</button>`;
      const time = m.createdAt?.toDate ? m.createdAt.toDate().toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}) : "";
      item.innerHTML = `<div class="bubble">${who}<div class="message-text${roleClass(m.senderId)}">${safeText(m.text)}</div><time>${time}</time></div>`;
      item.querySelector(".message-author").addEventListener("click", () => showPersonActions(m.senderId, senderLabel, chat.id));
      $("messages").append(item);
    });
    $("messages").scrollTop = $("messages").scrollHeight;
  }, err => toast("Could not load messages: " + err.message));
}
$("messageForm").addEventListener("submit", async e => {
  e.preventDefault();
  const text = $("messageInput").value.trim();
  if (!text || !activeChat) return;
  $("messageInput").value = "";
  try {
    await addDoc(collection(db, "chats", activeChat.id, "messages"), {
      text, senderId:currentUser.uid, senderName:profile.username, createdAt:serverTimestamp()
    });
    await updateDoc(doc(db, "chats", activeChat.id), { updatedAt:serverTimestamp(), lastMessage:text.slice(0,120) });
  } catch (err) { toast("Message not sent: " + err.message); $("messageInput").value = text; }
});

function openModal(title, html, confirmText, handler) {
  $("modalTitle").textContent = title;
  $("modalContent").innerHTML = html;
  $("modalConfirm").textContent = confirmText;
  showError("modalError", "");
  $("modal").showModal();
  $("modalForm").onsubmit = async e => {
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    try {
      await handler();
      $("modal").close();
    } catch (err) { showError("modalError", err.message || "Could not complete that action."); }
  };
}
$("addContactButton").addEventListener("click", () => openModal("Add a contact",
  `<label>Username<input id="lookupUsername" required minlength="3" maxlength="24" placeholder="Their exact username"></label>`,
  "Add contact", async () => {
    const username = $("lookupUsername").value.trim().toLowerCase();
    const q = query(collection(db,"users"), where("usernameLower","==",username));
    const result = await getDocs(q);
    const person = result.docs.find(d => d.id !== currentUser.uid);
    if (!person) throw new Error("No other user with that username was found.");
    await updateDoc(doc(db,"users",currentUser.uid), { contacts:arrayUnion(person.id) });
    toast("Contact added.");
  }));
$("newDirectButton").addEventListener("click", () => openModal("Start a private chat",
  `<label>Username<input id="directUsername" required placeholder="Their exact username"></label>`,
  "Start chat", async () => {
    const username = $("directUsername").value.trim().toLowerCase();
    const result = await getDocs(query(collection(db,"users"),where("usernameLower","==",username)));
    const personDoc = result.docs.find(d => d.id !== currentUser.uid);
    if (!personDoc) throw new Error("User not found.");
    await startDirect(personDoc.data());
  }));
async function startDirect(person) {
  const uid = person.uid;
  const existing = await getDocs(query(collection(db,"chats"),where("members","array-contains",currentUser.uid)));
  const match = existing.docs.find(d => d.data().type === "direct" && d.data().members.includes(uid));
  if (match) { openChat({id:match.id,...match.data()}); return; }
  const chat = await addDoc(collection(db,"chats"), {
    type:"direct", members:[currentUser.uid,uid],
    memberNames:{[currentUser.uid]:profile.username,[uid]:person.username},
    createdAt:serverTimestamp(), updatedAt:serverTimestamp(), lastMessage:""
  });
  openChat({id:chat.id,type:"direct",members:[currentUser.uid,uid],memberNames:{[currentUser.uid]:profile.username,[uid]:person.username}});
}
$("newGroupButton").addEventListener("click", () => openModal("Create a group",
  `<label>Group name<input id="groupName" required maxlength="40" placeholder="e.g. Weekend plans"></label><label>Members (usernames, comma separated)<input id="groupMembers" placeholder="alex, sam"></label><p class="tiny muted">You will be the group owner. Members must already have accounts.</p>`,
  "Create group", async () => {
    const name = $("groupName").value.trim();
    if (!name) throw new Error("Enter a group name.");
    const names = $("groupMembers").value.split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
    const memberIds = [currentUser.uid];
    const memberNames = {[currentUser.uid]:profile.username};
    for (const username of [...new Set(names)]) {
      const result = await getDocs(query(collection(db,"users"),where("usernameLower","==",username)));
      const found = result.docs.find(d=>d.id !== currentUser.uid);
      if (!found) throw new Error(`Could not find @${username}.`);
      memberIds.push(found.id); memberNames[found.id] = found.data().username;
    }
    if (memberIds.length < 2) throw new Error("Add at least one other member.");
    const group = await addDoc(collection(db,"chats"), {
      type:"group", name, ownerId:currentUser.uid, members:memberIds, memberNames,
      createdAt:serverTimestamp(), updatedAt:serverTimestamp(), lastMessage:""
    });
    openChat({id:group.id,type:"group",name,members:memberIds,memberNames,ownerId:currentUser.uid});
    toast("Group created.");
  }));
async function showGroupInfo() {
  const chat = activeChat;
  if (!chat || chat.type !== "group") return;
  const memberLines = chat.members.map(uid => `<li><button class="member-action${roleClass(uid)}" type="button" data-member-uid="${safeText(uid)}">${safeText(displayName(chat.memberNames?.[uid], uid))}</button>${uid===chat.ownerId ? " · owner" : ""}</li>`).join("");
  const canManage = chat.ownerId === currentUser.uid;
  openModal("Group information",
    `<p><strong>${safeText(chat.name)}</strong></p><p class="muted tiny">${chat.members.length} members</p><ul class="member-list">${memberLines}</ul>${canManage ? `<label>Add member by username<input id="addGroupMember" placeholder="username"></label><label>Remove member<select id="removeGroupMember">${chat.members.filter(uid=>uid!==currentUser.uid).map(uid=>`<option value="${safeText(uid)}">${safeText(chat.memberNames?.[uid] || uid)}</option>`).join("")}</select></label>` : ""}`,
    canManage ? "Save changes" : "Close", async () => {
      if (!canManage) return;
      const addName = $("addGroupMember").value.trim().toLowerCase();
      let members = [...chat.members], memberNames = {...chat.memberNames};
      if (addName) {
        const result = await getDocs(query(collection(db,"users"),where("usernameLower","==",addName)));
        const found = result.docs.find(d=>!members.includes(d.id));
        if (!found) throw new Error("New member not found or already in group.");
        members.push(found.id); memberNames[found.id] = found.data().username;
      }
      const removeId = $("removeGroupMember").value;
      if (removeId && members.includes(removeId)) { members = members.filter(x=>x!==removeId); delete memberNames[removeId]; }
      await updateDoc(doc(db,"chats",chat.id),{members,memberNames,updatedAt:serverTimestamp()});
      activeChat = {...chat,members,memberNames};
      toast("Group updated.");
    });
  $("modalContent").querySelectorAll("[data-member-uid]").forEach(btn => btn.addEventListener("click", () => showPersonActions(btn.dataset.memberUid, btn.textContent, chat.id)));
}
async function leaveGroup() {
  if (activeChat?.type !== "group") return;
  await updateDoc(doc(db,"chats",activeChat.id),{members:arrayRemove(currentUser.uid)});
  activeChat = null; $("messagesPanel").classList.add("hidden"); $("welcomePanel").classList.remove("hidden");
  toast("You left the group.");
}


// Moderation is tied to fixed Firebase Auth UIDs, never to editable usernames.
function setupModeration() {
  stopReports?.(); stopAnnouncements?.();
  stopAnnouncements = onSnapshot(query(collection(db, "announcements"), orderBy("createdAt", "desc")), snap => {
    const latest = snap.docs[0];
    if (latest && !window.__connectSeenAnnouncement?.has(latest.id)) {
      window.__connectSeenAnnouncement ||= new Set();
      window.__connectSeenAnnouncement.add(latest.id);
      const a = latest.data();
      toast(`📢 ${a.title || "Connect announcement"}: ${a.message || ""}`);
    }
  }, err => console.warn("Announcement listener:", err));
  if (!isAdmin()) return;
  stopReports = onSnapshot(query(collection(db, "reports"), where("status", "==", "open")), snap => {
    const count = snap.size;
    const badge = $("reportCount");
    if (badge) { badge.textContent = String(count); badge.classList.toggle("hidden", !count); }
    if (adminView === "reports" && !$("adminWorkspace").classList.contains("hidden")) renderReports(snap.docs);
  }, err => toast("Could not load moderation reports: " + err.message));
}
function setupAdminNavigation() {
  const tools = $("adminTools");
  if (!isAdmin()) { tools?.classList.add("hidden"); return; }
  tools.classList.remove("hidden");
  const consoleOnly = roleFor() !== "console";
  $("adminOwnerOnly").classList.toggle("hidden", consoleOnly);
  $("adminAnnouncementsButton").classList.toggle("hidden", consoleOnly);
  $("adminChatsTab").classList.toggle("hidden", consoleOnly);
  $("adminAnnouncementsTab").classList.toggle("hidden", consoleOnly);
  $("adminToolsButton").onclick = () => showAdminWorkspace("reports");
  document.querySelectorAll("[data-admin-view]").forEach(btn => btn.onclick = () => showAdminWorkspace(btn.dataset.adminView));
}
async function showPersonActions(uid, name, chatId) {
  if (!uid || uid === currentUser.uid) return;
  if (isAdmin(uid)) { toast("Admin accounts cannot be reported or banned here."); return; }
  if (isAdmin()) {
    openModal("Ban account", `<p>Ban <strong>${safeText(name)}</strong> from Connect?</p><label>Reason (optional)<input id="banReason" maxlength="180" placeholder="Reason for the ban"></label><p class="tiny muted">The ban is enforced by Firebase rules. The account will lose access to chats and messages.</p>`, "Ban account", async () => {
      const reason = $("banReason").value.trim();
      await updateDoc(doc(db, "users", uid), { banned:true, banReason:reason, bannedAt:serverTimestamp(), bannedBy:currentUser.uid });
      toast(`${name} has been banned.`);
    });
  } else {
    openModal("Report account", `<p>Report <strong>${safeText(name)}</strong> to the Connect moderation team.</p><label>Reason<select id="reportReason" required><option value="Harassment">Harassment or bullying</option><option value="Spam">Spam or unwanted messages</option><option value="Inappropriate content">Inappropriate content</option><option value="Impersonation">Impersonation</option><option value="Other">Other</option></select></label><label>Details (optional)<input id="reportDetails" maxlength="500" placeholder="Add context for the moderators"></label><p class="tiny muted">You can report this account once every 24 hours. Reports are private to Owner and Console.</p><button id="messagePersonButton" class="secondary" type="button">Message this person</button>`, "Send report", async () => {
      const reportId = `${currentUser.uid}_${uid}`;
      const reportRef = doc(db, "reports", reportId);
      try {
        await setDoc(reportRef, { reporterUid:currentUser.uid, reporterName:profile.username, targetUid:uid, targetName:name, chatId:chatId || null, reason:$("reportReason").value, details:$("reportDetails").value.trim(), status:"open", createdAt:serverTimestamp() });
      } catch (err) {
        if (err.code === "permission-denied") throw new Error("You already reported this account recently. You can report the same account once every 24 hours.");
        throw err;
      }
      toast("Report sent to the moderation team.");
    });
    $("messagePersonButton")?.addEventListener("click", async () => {
      $("modal").close();
      const personSnap = await getDoc(doc(db,"users",uid));
      if (personSnap.exists()) await startDirect(personSnap.data());
    });
  }
}
function renderReports(docs) {
  const host = $("adminContent"); if (!host) return;
  host.innerHTML = `<h2>Moderation reports</h2><p class="muted tiny">Reports are visible only to Owner and Console.</p>`;
  const render = [...(docs || [])].sort((a,b) => (b.data().createdAt?.toMillis?.() || 0) - (a.data().createdAt?.toMillis?.() || 0));
  if (!render.length) { host.innerHTML += `<p class="empty-admin">No open reports. You're all caught up.</p>`; return; }
  render.forEach(d => {
    const r = d.data(); const card = document.createElement("article"); card.className = "admin-card";
    const date = r.createdAt?.toDate ? r.createdAt.toDate().toLocaleString() : "Just now";
    const reviewButton = roleFor() === "console" ? `<button class="secondary" data-report-chat="${safeText(r.chatId || "")}" ${r.chatId ? "" : "disabled"}>Review chat</button>` : "";
    card.innerHTML = `<div class="admin-card-top"><strong>${safeText(r.targetName || "Unknown user")}</strong><span class="tiny muted">${safeText(date)}</span></div><p><b>Reason:</b> ${safeText(r.reason || "Not specified")}</p><p><b>Reported by:</b> ${safeText(r.reporterName || "User")}</p><p>${safeText(r.details || "No additional details.")}</p><div class="admin-card-actions">${reviewButton}<button class="secondary" data-dismiss="${safeText(d.id)}">Dismiss</button><button class="danger" data-ban="${safeText(r.targetUid)}" data-ban-name="${safeText(r.targetName || "user")}">Ban user</button></div>`;
    host.append(card);
  });
  host.querySelectorAll("[data-dismiss]").forEach(b => b.onclick = async () => { await updateDoc(doc(db,"reports",b.dataset.dismiss),{status:"dismissed",reviewedBy:currentUser.uid,reviewedAt:serverTimestamp()}); toast("Report dismissed."); });
  host.querySelectorAll("[data-ban]").forEach(b => b.onclick = () => showPersonActions(b.dataset.ban,b.dataset.banName,null));
  host.querySelectorAll("[data-report-chat]").forEach(b => b.onclick = () => openAdminChat(b.dataset.reportChat));
}
async function renderAdminChats() {
  const host = $("adminContent"); if (!host) return;
  host.innerHTML = `<h2>Chat management</h2><p class="muted tiny">Console can review chats and remove groups or conversations. Deletion removes their messages too.</p><p class="muted">Loading chats…</p>`;
  stopAdminChats?.();
  stopAdminChats = onSnapshot(query(collection(db,"chats"),orderBy("updatedAt","desc")), snap => {
    host.innerHTML = `<h2>Chat management</h2><p class="muted tiny">Console can review chats and remove groups or conversations. Deletion removes their messages too.</p>`;
    if (!snap.size) { host.innerHTML += `<p class="empty-admin">No chats found.</p>`; return; }
    snap.docs.forEach(d => {
      const c = d.data(); const card = document.createElement("article"); card.className = "admin-card";
      card.innerHTML = `<div class="admin-card-top"><strong>${safeText(c.type === "group" ? c.name : "Private chat")}</strong><span class="tiny muted">${safeText(c.type || "chat")} · ${(c.members || []).length} members</span></div><p class="tiny muted">${safeText((c.members || []).map(uid => c.memberNames?.[uid] || uid.slice(0,8)).join(", "))}</p><div class="admin-card-actions"><button class="secondary" data-review="${safeText(d.id)}">Review messages</button><button class="danger" data-delete-chat="${safeText(d.id)}">Delete chat</button></div>`;
      host.append(card);
    });
    host.querySelectorAll("[data-review]").forEach(b => b.onclick = () => openAdminChat(b.dataset.review));
    host.querySelectorAll("[data-delete-chat]").forEach(b => b.onclick = () => deleteAdminChat(b.dataset.deleteChat));
  }, err => { host.innerHTML = `<p class="error">Could not load chats: ${safeText(err.message)}</p>`; });
}
async function openAdminChat(chatId) {
  if (!chatId || roleFor() !== "console") return;
  const snap = await getDoc(doc(db,"chats",chatId));
  if (!snap.exists()) { toast("That chat no longer exists."); return; }
  const msgs = await getDocs(query(collection(db,"chats",chatId,"messages"),orderBy("createdAt","asc")));
  const lines = msgs.docs.map(d => { const m=d.data(); const stamp=m.createdAt?.toDate?.().toLocaleString() || ""; return `<article class="admin-message"><strong class="${roleClass(m.senderId).trim()}">${safeText(displayName(m.senderName,m.senderId))}</strong><p>${safeText(m.text)}</p><time>${safeText(stamp)}</time></article>`; }).join("");
  openModal("Chat review", `<p class="muted tiny">${safeText(chatTitle({id:chatId,...snap.data()}))} · ${msgs.size} messages</p><div class="admin-message-list">${lines || "<p>No messages in this chat.</p>"}</div>`, "Close", async () => {});
}
async function deleteAdminChat(chatId) {
  if (roleFor() !== "console" || !confirm("Permanently delete this chat and all of its messages?")) return;
  const msgs = await getDocs(collection(db,"chats",chatId,"messages"));
  for (const m of msgs.docs) await deleteDoc(m.ref);
  await deleteDoc(doc(db,"chats",chatId));
  toast("Chat and its messages deleted.");
}
function renderAnnouncementForm() {
  const host = $("adminContent"); if (!host) return;
  if (roleFor() !== "console") { host.innerHTML = `<p>Only Console can publish announcements.</p>`; return; }
  host.innerHTML = `<h2>Public announcements</h2><p class="muted tiny">Send a notification to everyone signed in to Connect.</p><form id="announcementForm"><label>Title<input id="announcementTitle" maxlength="70" required placeholder="Important update"></label><label>Message<textarea id="announcementMessage" maxlength="700" required placeholder="Write your announcement…"></textarea></label><button class="primary" type="submit">Publish announcement</button></form><div id="announcementHistory"></div>`;
  $("announcementForm").onsubmit = async e => { e.preventDefault(); const title=$("announcementTitle").value.trim(), message=$("announcementMessage").value.trim(); if(!title || !message) return; await addDoc(collection(db,"announcements"),{title,message,authorUid:currentUser.uid,authorName:"Console",createdAt:serverTimestamp()}); $("announcementForm").reset(); toast("Announcement published."); };
}

// WebRTC call signaling: peer-to-peer mesh, suitable for small groups (best for 2–4 people).
// A TURN server may be needed for users on restrictive networks.
async function startCall() {
  if (!activeChat) return;
  if (!navigator.mediaDevices?.getUserMedia) { toast("Camera/microphone access requires HTTPS and a supported browser."); return; }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    $("localVideo").srcObject = localStream;
    $("remoteVideo").classList.add("hidden");
    $("callTitle").textContent = chatTitle(activeChat);
    $("callStatus").textContent = "Waiting for other members to join…";
    $("callDialog").showModal();
    callId = activeChat.id;
    callRoom = `calls/${callId}`;
    isCaller = true;
    const roomRef = ref(rtdb,callRoom);
    const snapshot = await new Promise(resolve => onValue(roomRef, s=>resolve(s), {onlyOnce:true}));
    if (snapshot.exists()) {
      const data = snapshot.val();
      if (data.startedBy !== currentUser.uid && Date.now() - (data.startedAt || 0) < 120000) {
        // Join the existing call room.
      } else await remove(roomRef);
    }
    await update(ref(rtdb,callRoom),{startedBy:currentUser.uid,startedAt:Date.now(),chatId:activeChat.id});
    await set(ref(rtdb,`${callRoom}/participants/${currentUser.uid}`),{username:profile.username});
    onDisconnect(ref(rtdb,`${callRoom}/participants/${currentUser.uid}`)).remove();
    listenCallParticipants();
  } catch (err) { toast("Could not start call: " + err.message); await endCall(false); }
}
function listenCallParticipants() {
  const participantsRef = ref(rtdb,`${callRoom}/participants`);
  const unsub = onValue(participantsRef, snap => {
    const participants = snap.val() || {};
    Object.keys(participants).filter(uid=>uid!==currentUser.uid).forEach(uid => {
      if (!peerConnections.has(uid)) createOffer(uid);
    });
    $("callStatus").textContent = `${Object.keys(participants).length} participant(s)`;
  });
  callListeners.push(unsub);
}
async function createPeer(uid) {
  const pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  peerConnections.set(uid,pc);
  localStream.getTracks().forEach(track=>pc.addTrack(track,localStream));
  pc.ontrack = e => {
    $("remoteVideo").srcObject = e.streams[0];
    $("remoteVideo").classList.remove("hidden");
  };
  pc.onicecandidate = e => { if(e.candidate) push(ref(rtdb,`${callRoom}/signals/${uid}/candidates`),e.candidate.toJSON()); };
  return pc;
}
async function createOffer(uid) {
  const pc = await createPeer(uid);
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  await set(ref(rtdb,`${callRoom}/signals/${uid}/offer`),{sdp:offer.sdp,type:offer.type,from:currentUser.uid});
  const answerUnsub = onValue(ref(rtdb,`${callRoom}/signals/${currentUser.uid}/answer`),async snap=>{
    if(snap.exists() && pc.signalingState!=="stable") await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));
  });
  callListeners.push(answerUnsub);
  const candidateUnsub = onChildAdded(ref(rtdb,`${callRoom}/signals/${currentUser.uid}/candidates`),snap=>{
    const candidate=snap.val(); if(candidate) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{});
  });
  callListeners.push(candidateUnsub);
}
async function joinIncomingCall(chat) {
  activeChat = chat;
  callId = chat.id; callRoom = `calls/${callId}`; isCaller = false;
  localStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
  $("localVideo").srcObject=localStream; $("callTitle").textContent=chatTitle(chat);
  $("callDialog").showModal();
  const offerRef=ref(rtdb,`${callRoom}/signals/${currentUser.uid}/offer`);
  const offerSnap=await new Promise(resolve=>onValue(offerRef,s=>resolve(s),{onlyOnce:true}));
  if(!offerSnap.exists()) throw new Error("Call invitation expired.");
  const offer=offerSnap.val(); const pc=await createPeer(offer.from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer=await pc.createAnswer(); await pc.setLocalDescription(answer);
  await set(ref(rtdb,`${callRoom}/signals/${offer.from}/answer`),{sdp:answer.sdp,type:answer.type});
}
async function endCall(removeRoom=true) {
  callListeners.forEach(fn=>{try{fn();}catch{}}); callListeners=[];
  peerConnections.forEach(pc=>pc.close()); peerConnections.clear();
  localStream?.getTracks().forEach(t=>t.stop()); localStream=null;
  $("localVideo").srcObject=null; $("remoteVideo").srcObject=null;
  if(callId && currentUser) {
    await remove(ref(rtdb,`calls/${callId}/participants/${currentUser.uid}`)).catch(()=>{});
    if(removeRoom && isCaller) await remove(ref(rtdb,`calls/${callId}`)).catch(()=>{});
  }
  callId=null; callRoom=null;
  if($("callDialog").open) $("callDialog").close();
}
$("hangupButton").addEventListener("click",()=>endCall(true));
$("muteButton").addEventListener("click",()=>{
  const track=localStream?.getAudioTracks()[0]; if(!track)return;
  track.enabled=!track.enabled; $("muteButton").textContent=track.enabled?"Mute":"Unmute";
});
$("cameraButton").addEventListener("click",()=>{
  const track=localStream?.getVideoTracks()[0]; if(!track)return;
  track.enabled=!track.enabled; $("cameraButton").textContent=track.enabled?"Camera off":"Camera on";
});
$("themeButton").addEventListener("click",()=>document.body.classList.toggle("light"));
window.addEventListener("beforeunload",()=>{ localStream?.getTracks().forEach(t=>t.stop()); });

/* Incoming call notices: the caller writes a room record; clients with access
   to a chat can see it. Joining a call is intentionally explicit. */
let seenCallKeys = new Set();
function watchIncomingCalls() {
  const q = query(collection(db,"chats"),where("members","array-contains",currentUser.uid));
  onSnapshot(q,snap=>{
    snap.docs.forEach(async d=>{
      const chat={id:d.id,...d.data()};
      const callSnap=await new Promise(resolve=>onValue(ref(rtdb,`calls/${chat.id}`),s=>resolve(s),{onlyOnce:true}));
      const call=callSnap.val();
      if(call?.startedBy && call.startedBy!==currentUser.uid && !seenCallKeys.has(chat.id)) {
        seenCallKeys.add(chat.id);
        if(confirm(`${chatTitle(chat)} is calling. Join?`)) {
          try { await joinIncomingCall(chat); } catch(err) { toast(err.message); await endCall(false); }
        }
      }
    });
  });
}
const authObserver = onAuthStateChanged(auth, user => { if(user) setTimeout(watchIncomingCalls,1200); });
