const ACCOUNT_USER_KEY = "peerPressureCurrentUser";

const accountClient = (() => {
  const config = window.PEER_PRESSURE_SUPABASE || {};
  if (!config.url || !config.anonKey || !window.supabase) return null;
  return window.supabase.createClient(config.url, config.anonKey);
})();

syncAccountUi();

async function syncAccountUi() {
  const accountName = document.querySelector("#accountName");
  const authAction = document.querySelector("#authAction");
  const signOutButton = document.querySelector("#signOutButton");
  const walletBalance = document.querySelector("#walletBalance");

  if (!accountClient) {
    updateAccountDisplay("Guest", false);
    return;
  }

  const { data } = await accountClient.auth.getUser();
  const user = data && data.user;

  if (!user) {
    updateAccountDisplay("Guest", false);
    window.dispatchEvent(new CustomEvent("peerpressure:userchange"));
    return;
  }

  const username = await loadUsername(user);
  localStorage.setItem(ACCOUNT_USER_KEY, username);
  updateAccountDisplay(username, true);
  window.dispatchEvent(new CustomEvent("peerpressure:userchange"));

  if (signOutButton) {
    signOutButton.addEventListener("click", async () => {
      await accountClient.auth.signOut();
      localStorage.removeItem(ACCOUNT_USER_KEY);
      window.location.href = "auth.html";
    }, { once: true });
  }

  function updateAccountDisplay(name, signedIn) {
    if (accountName) accountName.textContent = name;
    if (walletBalance) walletBalance.textContent = signedIn ? "Loading..." : "Sign in";
    if (authAction) {
      authAction.textContent = signedIn ? "Account" : "Sign In";
      authAction.href = "auth.html";
    }
    if (signOutButton) signOutButton.hidden = !signedIn;
  }
}

async function loadUsername(user) {
  const metadataName = user.user_metadata && user.user_metadata.username;

  const { data } = await accountClient
    .from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();

  return (data && data.username) || metadataName || user.email || "Friend";
}
