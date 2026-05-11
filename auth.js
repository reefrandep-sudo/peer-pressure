const authClient = (() => {
  const config = window.PEER_PRESSURE_SUPABASE || {};
  if (!config.url || !config.anonKey || !window.supabase) return null;
  return window.supabase.createClient(config.url, config.anonKey);
})();

const signupForm = document.querySelector("#signupForm");
const signinForm = document.querySelector("#signinForm");
const statusLine = document.querySelector("#connectionStatus");

if (!authClient) setStatus("Account system is not connected yet.", "error");
if (authClient && signinForm) completeEmailVerificationIfPresent();

signupForm && signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!authClient) return;

  const username = valueOf("signupUsername");
  const email = valueOf("signupEmail").toLowerCase();
  const password = valueOf("signupPassword");

  localStorage.setItem("peerPressurePendingUsername", username);
  localStorage.setItem("peerPressurePendingEmail", email);

  const { error } = await authClient.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: getAuthRedirectUrl(),
      data: { username }
    }
  });

  if (error) {
    setStatus(friendlyAuthError(error.message), "error");
    return;
  }

  window.location.href = `check-email.html?email=${encodeURIComponent(email)}`;
});

signinForm && signinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!authClient) return;

  const email = valueOf("signinEmail").toLowerCase();
  const password = valueOf("signinPassword");

  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error) {
    setStatus(friendlyAuthError(error.message), "error");
    return;
  }

  const user = data && data.user;
  await completeSignedInUser(user);
});

async function completeEmailVerificationIfPresent() {
  const { data } = await authClient.auth.getSession();
  const user = data && data.session && data.session.user;
  if (!user) return;

  setStatus("Email verified. Taking you to Peer Pressure...", "live");
  await completeSignedInUser(user);
}

async function completeSignedInUser(user) {
  if (!user) return;

  const username = await loadUsername(user);
  await saveProfile(user.id, username, user.email || "");
  localStorage.setItem("peerPressureCurrentUser", username);
  localStorage.removeItem("peerPressurePendingUsername");
  localStorage.removeItem("peerPressurePendingEmail");
  setStatus("Signed in. Taking you back to Peer Pressure...", "live");
  window.location.href = "index.html";
}

async function saveProfile(id, username, email) {
  const { error } = await authClient.from("profiles").upsert({
    id,
    username,
    email
  });

  if (error) setStatus(error.message, "error");
}

async function loadUsername(user) {
  const { data } = await authClient
    .from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();

  return (
    (data && data.username)
    || (user.user_metadata && user.user_metadata.username)
    || localStorage.getItem("peerPressurePendingUsername")
    || user.email
    || "Friend"
  );
}

function getAuthRedirectUrl() {
  const configuredUrl = window.PEER_PRESSURE_SUPABASE && window.PEER_PRESSURE_SUPABASE.authRedirectUrl;
  if (configuredUrl) return configuredUrl;

  return new URL("auth.html", window.location.href).toString();
}

function friendlyAuthError(message) {
  const lower = message.toLowerCase();
  if (lower.includes("email not confirmed") || lower.includes("email_confirmed")) {
    return "That email still needs to be verified. Open the Supabase email and click the confirmation link, then sign in again.";
  }

  if (lower.includes("invalid login credentials")) {
    return "Those login details do not match. Check the email and password, or create a new account.";
  }

  return message;
}

function valueOf(id) {
  return document.querySelector(`#${id}`).value.trim();
}

function setStatus(message, state) {
  if (!statusLine) return;
  statusLine.textContent = message;
  statusLine.classList.toggle("live", state === "live");
  statusLine.classList.toggle("error", state === "error");
}
