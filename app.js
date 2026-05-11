const STORAGE_KEY = "peerPressurePrototype";
const USER_KEY = "peerPressureCurrentUser";
const FOLLOW_KEY = "peerPressureFollowedMarkets";
const INVITE_KEY = "peerPressureInviteCodes";
const HIDDEN_PLATFORM_FEE = 2;
const HIDDEN_ODDS_RAKE = 3;
const marketMath = window.PeerPressureMath;

const pageParams = new URLSearchParams(window.location.search);
const detailMarketId = pageParams.get("id") || "";
const isDetailPage = Boolean(detailMarketId);

function relativeLocalDate({ days = 0, hours = 0, minutes = 0 }) {
  const date = new Date();
  date.setSeconds(0, 0);
  date.setDate(date.getDate() + days);
  date.setHours(date.getHours() + hours);
  date.setMinutes(date.getMinutes() + minutes);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

const defaultMarkets = [
  {
    id: "demo-sam-call",
    question: "Will Sam call us today?",
    deadline: relativeLocalDate({ days: 1, hours: 10 }),
    cutoff: relativeLocalDate({ days: 1, hours: 6 }),
    umpire: "Alex",
    minStake: 5,
    platformFee: HIDDEN_PLATFORM_FEE,
    oddsRake: HIDDEN_ODDS_RAKE,
    visibility: "PUBLIC",
    inviteCode: "",
    terms: "Counts only if the call is received before midnight. Missed calls count. Texts do not.",
    status: "OPEN",
    outcome: "",
    entries: [
      { id: "demo-sam-you-yes", person: "You", side: "YES", amount: 10 },
      { id: "demo-sam-jordan-no", person: "Jordan", side: "NO", amount: 10 },
      { id: "demo-sam-taylor-yes", person: "Taylor", side: "YES", amount: 5 }
    ]
  },
  {
    id: "demo-friday-dinner",
    question: "Will the group dinner happen this Friday?",
    deadline: relativeLocalDate({ days: 3, hours: 8 }),
    cutoff: relativeLocalDate({ days: 3, hours: 2 }),
    umpire: "Mia",
    minStake: 5,
    platformFee: HIDDEN_PLATFORM_FEE,
    oddsRake: HIDDEN_ODDS_RAKE,
    visibility: "PUBLIC",
    inviteCode: "",
    terms: "Dinner counts if at least four people attend and food is ordered by 9pm.",
    status: "OPEN",
    outcome: "",
    entries: [
      { id: "demo-dinner-you-no", person: "You", side: "NO", amount: 20 },
      { id: "demo-dinner-mia-yes", person: "Mia", side: "YES", amount: 15 }
    ]
  }
];

let markets = [];
let activeFilter = "open";
let dbClient = null;
let realtimeChannel = null;
let isSharedMode = false;
let currentUserId = "";
let walletBalance = null;
let walletTransactions = [];
let walletError = "";

const money = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0
});

const marketForm = document.querySelector("#marketForm");
const marketList = document.querySelector("#marketList");
const template = document.querySelector("#marketCardTemplate");
const connectionStatus = document.querySelector("#connectionStatus");
const inviteForm = document.querySelector("#inviteForm");
const walletBalanceRead = document.querySelector("#walletBalance");
const walletPanelBalance = document.querySelector("#walletPanelBalance");
const walletPanelRead = document.querySelector("#walletPanelRead");
const walletTransactionsList = document.querySelector("#walletTransactions");

document.body.classList.toggle("detail-mode", isDetailPage);
document.body.classList.toggle("list-mode", !isDetailPage);
window.addEventListener("peerpressure:userchange", render);

if (marketForm) {
  marketForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const visibility = document.querySelector("input[name='visibility']:checked").value;

    const market = {
      id: crypto.randomUUID(),
      question: valueOf("question"),
      deadline: valueOf("deadline"),
      cutoff: valueOf("cutoff"),
      umpire: valueOf("umpire"),
      minStake: numberOf("minStake"),
      platformFee: HIDDEN_PLATFORM_FEE,
      oddsRake: HIDDEN_ODDS_RAKE,
      visibility,
      inviteCode: visibility === "INVITE_ONLY" ? createInviteCode() : "",
      terms: valueOf("terms") || "No extra terms added.",
      status: "OPEN",
      outcome: "",
      entries: []
    };

    const validationError = validateMarket(market);
    if (validationError) {
      setConnection(validationError, "error");
      return;
    }

    let created = true;
    if (isSharedMode) {
      created = await createSharedMarket(market);
    } else {
      markets.unshift(market);
      saveLocalMarkets();
      render();
    }

    if (created) {
      window.location.href = "index.html";
    }
  });
}

document.querySelectorAll(".filter-button").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    document.querySelectorAll(".filter-button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    render();
  });
});

if (inviteForm) {
  inviteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = valueOf("inviteCode").toUpperCase();
    if (!code) return;

    if (isSharedMode) {
      await joinSharedInvite(code);
    } else {
      saveInviteCode(code);
      render();
    }

    document.querySelector("#inviteCode").value = "";
  });
}

boot();

async function boot() {
  dbClient = createDatabaseClient();
  isSharedMode = Boolean(dbClient);

  if (isSharedMode) {
    setConnection("Connecting to shared markets...", "live");
    const user = await getSignedInUser();
    currentUserId = user ? user.id : "";
    await loadWallet();
    await loadSharedMarkets();
    subscribeToSharedChanges();
  } else {
    markets = loadLocalMarkets();
    setConnection("Demo mode: bets are saved on this device.", "");
    renderWallet();
    render();
  }
}

function createDatabaseClient() {
  const config = window.PEER_PRESSURE_SUPABASE || {};
  const hasConfig = config.url && config.anonKey;
  const hasLibrary = window.supabase && window.supabase.createClient;

  if (!hasConfig || !hasLibrary) return null;
  return window.supabase.createClient(config.url, config.anonKey);
}

async function getSignedInUser() {
  if (!dbClient) return null;
  const { data } = await dbClient.auth.getUser();
  return data && data.user ? data.user : null;
}

async function loadWallet() {
  if (!isSharedMode || !currentUserId) {
    walletBalance = null;
    walletTransactions = [];
    walletError = "";
    renderWallet();
    return;
  }

  const { data, error } = await dbClient.rpc("ensure_test_wallet");
  if (error) {
    walletBalance = null;
    walletTransactions = [];
    walletError = `Wallet unavailable: ${error.message}`;
    renderWallet();
    return;
  }

  walletBalance = Number(data || 0);
  walletError = "";
  await loadWalletTransactions();
  renderWallet();
}

async function loadWalletTransactions() {
  const { data, error } = await dbClient
    .from("wallet_transactions")
    .select("transaction_type, amount, balance_after, note, created_at")
    .order("created_at", { ascending: false })
    .limit(8);

  walletTransactions = error ? [] : data || [];
}

async function loadSharedMarkets() {
  const { data, error } = await dbClient
    .from("markets")
    .select("*, entries(*)")
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    setConnection(`Supabase error: ${error.message}`, "error");
    markets = loadLocalMarkets();
    isSharedMode = false;
  } else {
    markets = data.map(fromDatabaseMarket);
    setConnection(isDetailPage ? "Shared mode: bet detail syncs through Supabase." : "Shared mode: markets sync through Supabase.", "live");
  }

  render();
}

function subscribeToSharedChanges() {
  if (realtimeChannel) dbClient.removeChannel(realtimeChannel);

  realtimeChannel = dbClient
    .channel("peer-pressure-shared-markets")
    .on("postgres_changes", { event: "*", schema: "public", table: "markets" }, loadSharedMarkets)
    .on("postgres_changes", { event: "*", schema: "public", table: "entries" }, loadSharedMarkets)
    .on("postgres_changes", { event: "*", schema: "public", table: "market_participants" }, loadSharedMarkets)
    .on("postgres_changes", { event: "*", schema: "public", table: "wallets" }, loadWallet)
    .on("postgres_changes", { event: "*", schema: "public", table: "wallet_transactions" }, loadWallet)
    .subscribe();
}

async function createSharedMarket(market) {
  const user = await getSignedInUser();

  if (!user) {
    setConnection("Please sign in before creating a bet.", "error");
    return false;
  }

  currentUserId = user.id;
  const payload = toDatabaseMarket(market);
  payload.owner_id = user.id;

  const { error } = await dbClient.from("markets").insert(payload);

  if (error) {
    setConnection(`Could not create bet: ${error.message}`, "error");
    return false;
  }

  return true;
}

async function createSharedEntry(market, entry) {
  const user = await getSignedInUser();

  if (!user) {
    setConnection("Please sign in before joining a bet.", "error");
    return;
  }

  const joinMessage = marketJoinBlockReason(market);
  if (joinMessage) {
    setConnection(joinMessage, "error");
    return;
  }

  currentUserId = user.id;
  const person = currentDisplayName();
  const existingSide = sideForCurrentUser(market, person, user.id);
  if (existingSide && existingSide !== entry.side) {
    setConnection(`You are already on ${existingSide}. You can add more there, but you cannot switch sides.`, "error");
    return;
  }

  const { error } = await dbClient.rpc("place_test_bet", {
    target_market_id: market.id,
    selected_side: entry.side,
    stake_amount: entry.amount
  });

  if (error) {
    setConnection(`Could not join bet: ${error.message}`, "error");
    return;
  }

  await loadWallet();
  await loadSharedMarkets();
}

async function joinSharedInvite(code) {
  const { data, error } = await dbClient.rpc("join_market_by_invite", { invite: code });

  if (error) {
    setConnection(`Could not open invite: ${error.message}`, "error");
    return;
  }

  saveInviteCode(code);
  setConnection("Invite opened. Private bet added to your markets.", "live");
  await loadSharedMarkets();
  if (data) window.location.href = `detail.html?id=${data}`;
}

async function resolveSharedMarket(market, outcome) {
  const { error } = await dbClient.rpc("resolve_market_with_test_wallets", {
    target_market_id: market.id,
    result: outcome
  });

  if (error) {
    setConnection(`Could not resolve bet: ${error.message}`, "error");
    return;
  }

  await loadWallet();
  await loadSharedMarkets();
}

function fromDatabaseMarket(row) {
  return {
    id: row.id,
    ownerId: row.owner_id || "",
    question: row.question,
    deadline: toLocalInputDate(row.deadline),
    cutoff: toLocalInputDate(row.cutoff),
    umpire: row.umpire,
    minStake: Number(row.min_stake),
    platformFee: Number(row.platform_fee || HIDDEN_PLATFORM_FEE),
    oddsRake: Number(row.odds_rake),
    visibility: row.visibility || "PUBLIC",
    inviteCode: row.invite_code || "",
    terms: row.terms,
    status: row.status,
    outcome: row.outcome,
    settledAt: row.settled_at || "",
    settlementFeeTotal: Number(row.settlement_fee_total || 0),
    entries: (row.entries || []).map((entry) => ({
      id: entry.id,
      userId: entry.user_id || "",
      person: entry.person,
      side: entry.side,
      amount: Number(entry.amount),
      lockedProfit: Number(entry.locked_profit || 0),
      lockedPayout: Number(entry.locked_payout || 0)
    }))
  };
}

function toDatabaseMarket(market) {
  return {
    question: market.question,
    deadline: new Date(market.deadline).toISOString(),
    cutoff: new Date(market.cutoff).toISOString(),
    umpire: market.umpire,
    min_stake: market.minStake,
    platform_fee: market.platformFee,
    odds_rake: market.oddsRake,
    visibility: market.visibility,
    invite_code: market.inviteCode,
    terms: market.terms,
    status: market.status,
    outcome: market.outcome
  };
}

function loadLocalMarkets() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultMarkets;

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : defaultMarkets;
  } catch {
    return defaultMarkets;
  }
}

function saveLocalMarkets() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(markets));
}

function loadFollowedMarketIds() {
  const raw = localStorage.getItem(FOLLOW_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadInviteCodes() {
  const raw = localStorage.getItem(INVITE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveInviteCode(code) {
  const codes = new Set(loadInviteCodes());
  codes.add(code);
  localStorage.setItem(INVITE_KEY, JSON.stringify([...codes]));
}

function hasInviteAccess(market) {
  if (market.visibility !== "INVITE_ONLY") return true;
  if (isSharedMode) return true;
  return loadInviteCodes().includes(market.inviteCode) || isFollowing(market);
}

function isFollowing(market) {
  return loadFollowedMarketIds().includes(market.id);
}

function toggleFollow(market) {
  const followed = new Set(loadFollowedMarketIds());
  if (followed.has(market.id)) {
    followed.delete(market.id);
  } else {
    followed.add(market.id);
  }
  localStorage.setItem(FOLLOW_KEY, JSON.stringify([...followed]));
}

function currentDisplayName() {
  return localStorage.getItem(USER_KEY) || "You";
}

function valueOf(id) {
  const field = document.querySelector(`#${id}`);
  return field ? field.value.trim() : "";
}

function numberOf(id) {
  const field = document.querySelector(`#${id}`);
  return Number((field && field.value) || 0);
}

function getPools(market) {
  return marketMath.getPools(market);
}

function getTimelineState(market) {
  const now = new Date();
  const cutoff = market.cutoff ? new Date(market.cutoff) : null;
  const deadline = market.deadline ? new Date(market.deadline) : null;
  const bettingClosed = market.status !== "OPEN" || Boolean(cutoff && now >= cutoff);
  const eventEnded = Boolean(deadline && now >= deadline);
  const canResolve = market.status === "OPEN" && eventEnded;

  return {
    now,
    cutoff,
    deadline,
    bettingClosed,
    eventEnded,
    canJoin: market.status === "OPEN" && !bettingClosed,
    canResolve
  };
}

function getOdds(market) {
  return marketMath.getOdds(market);
}

function getPayout(market, entry) {
  return marketMath.getPayout(market, entry);
}

function quoteLockedPayout(market, side, amount) {
  return marketMath.quoteLockedPayout(market, side, amount);
}

function quoteRead(market, side, amount) {
  const joinMessage = joinFormBlockReason(market, amount);
  if (joinMessage) return joinMessage;
  const payout = quoteLockedPayout(market, side, amount);
  const profit = Math.max(0, payout - amount);
  return `Pays ${money.format(payout)} if ${side} wins (${money.format(profit)} profit)`;
}

function joinFormBlockReason(market, amount) {
  const joinMessage = marketJoinBlockReason(market);
  if (joinMessage) return joinMessage;
  if (isSharedMode && !currentUserId) return "Sign in to use test credits.";
  if (!amount || amount < market.minStake) return `Min stake ${money.format(market.minStake)}`;
  if (isSharedMode && walletBalance === null) return "Loading test balance.";
  if (isSharedMode && walletBalance !== null && amount > walletBalance) {
    return `Balance too low: ${money.format(walletBalance)} available.`;
  }
  return "";
}

function marketJoinBlockReason(market) {
  const timeline = getTimelineState(market);
  if (market.status !== "OPEN") return "This bet is settled.";
  if (timeline.bettingClosed) return "Betting is closed for this market.";
  return "";
}

function losingPoolForSide(market, side) {
  return marketMath.losingPoolForSide(market, side);
}

function sideForCurrentUser(market, fallbackName = currentDisplayName(), userId = currentUserId) {
  const matched = market.entries.find((entry) => {
    if (userId && entry.userId) return entry.userId === userId;
    return entry.person.trim().toLowerCase() === fallbackName.trim().toLowerCase();
  });

  return matched ? matched.side : "";
}

function filteredMarkets() {
  return markets.filter((market) => {
    if (!hasInviteAccess(market)) return false;
    if (isDetailPage) return market.id === detailMarketId;
    if (activeFilter === "followed") return isFollowing(market);
    if (activeFilter === "open") return market.status === "OPEN";
    if (activeFilter === "settled") return market.status === "SETTLED";
    return true;
  });
}

function render() {
  renderWallet();
  renderStats();
  renderMarkets();
}

function renderWallet(errorMessage = walletError) {
  if (walletBalanceRead) {
    if (!isSharedMode) walletBalanceRead.textContent = "Local demo";
    else if (!currentUserId) walletBalanceRead.textContent = "Sign in";
    else if (errorMessage) walletBalanceRead.textContent = "Unavailable";
    else walletBalanceRead.textContent = walletBalance === null ? "Loading..." : money.format(walletBalance);
  }

  if (!walletPanelBalance || !walletPanelRead || !walletTransactionsList) return;

  if (!isSharedMode) {
    walletPanelBalance.textContent = "Local demo mode";
    walletPanelRead.textContent = "Configure Supabase to use shared test credits with friends.";
    walletTransactionsList.replaceChildren();
    return;
  }

  if (!currentUserId) {
    walletPanelBalance.textContent = "Sign in for test credits";
    walletPanelRead.textContent = "Shared bets use fake credits, not real money.";
    walletTransactionsList.replaceChildren();
    return;
  }

  walletPanelBalance.textContent = walletBalance === null ? "Loading..." : money.format(walletBalance);
  walletPanelRead.textContent = errorMessage || "Fake credits let you test deposits, stakes, payouts, and void refunds without moving real money.";
  walletTransactionsList.replaceChildren();

  if (walletTransactions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "terms";
    empty.textContent = "No wallet activity yet.";
    walletTransactionsList.append(empty);
    return;
  }

  walletTransactions.forEach((transaction) => {
    const row = document.createElement("div");
    const amount = Number(transaction.amount || 0);
    row.className = "wallet-transaction";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(walletTransactionLabel(transaction.transaction_type))}</strong>
        <span>${escapeHtml(transaction.note || formatDate(transaction.created_at))}</span>
      </div>
      <strong class="${amount < 0 ? "debit" : "credit"}">${amount < 0 ? "-" : "+"}${money.format(Math.abs(amount))}</strong>
    `;
    walletTransactionsList.append(row);
  });
}

function renderStats() {
  const activeCount = document.querySelector("#activeCount");
  const followedCount = document.querySelector("#followedCount");
  const settledCount = document.querySelector("#settledCount");
  if (!activeCount || !followedCount || !settledCount) return;

  const visible = markets.filter(hasInviteAccess);
  const active = visible.filter((market) => market.status === "OPEN").length;
  const followed = visible.filter(isFollowing).length;
  const settled = visible.filter((market) => market.status === "SETTLED").length;

  activeCount.textContent = active;
  followedCount.textContent = followed;
  settledCount.textContent = settled;
}

function renderMarkets() {
  if (!marketList || !template) return;

  marketList.replaceChildren();
  const visibleMarkets = filteredMarkets();

  if (visibleMarkets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = isDetailPage ? "This bet is not available, or you do not have access yet." : "No bets match this view yet.";
    marketList.append(empty);
    return;
  }

  visibleMarkets.forEach((market) => {
    const card = template.content.firstElementChild.cloneNode(true);
    card.classList.toggle("market-card-summary", !isDetailPage);

    const pools = getPools(market);
    const odds = getOdds(market);
    const statusPill = card.querySelector(".status-pill");
    const visibilityPill = card.querySelector(".visibility-pill");
    const followButton = card.querySelector(".follow-button");
    const entryForm = card.querySelector(".entry-form");
    const sideSelect = card.querySelector(".side-select");
    const amountInput = card.querySelector(".amount-input");
    const quoteOutput = card.querySelector(".quote-read");
    const resolveRow = card.querySelector(".resolve-row");
    const resolveActions = card.querySelector(".resolve-actions");
    const ledger = card.querySelector(".ledger");
    const inviteRead = card.querySelector(".invite-read");
    const terms = card.querySelector(".terms");
    const timeline = getTimelineState(market);
    const resolveButtons = [...card.querySelectorAll("[data-outcome]")];
    const joinButton = entryForm.querySelector("button[type='submit']");
    const isOwner = !isSharedMode || Boolean(currentUserId && market.ownerId === currentUserId);

    card.querySelector("h3").textContent = market.question;
    card.querySelector(".cutoff").textContent = formatDate(market.cutoff);
    card.querySelector(".deadline").textContent = formatDate(market.deadline);
    terms.textContent = market.terms;
    renderInviteRead(card, market);
    card.querySelector(".yes-pool").textContent = money.format(pools.yes);
    card.querySelector(".no-pool").textContent = money.format(pools.no);
    card.querySelector(".yes-odds").textContent = `YES pool | ${formatProbability(odds.yesShare)} implied`;
    card.querySelector(".no-odds").textContent = `NO pool | ${formatProbability(odds.noShare)} implied`;
    card.querySelector(".payout-read").textContent = payoutRead(market);

    statusPill.textContent = marketStatusLabel(market, timeline);
    statusPill.classList.toggle("closed", market.status === "OPEN" && timeline.bettingClosed);
    statusPill.classList.toggle("void", market.outcome === "VOID");
    statusPill.classList.toggle("settled", market.status === "SETTLED" && market.outcome !== "VOID");
    visibilityPill.textContent = market.visibility === "INVITE_ONLY" ? "Invite only" : "Public";

    followButton.textContent = isFollowing(market) ? "Following" : "Follow";
    followButton.classList.toggle("following", isFollowing(market));
    followButton.addEventListener("click", () => {
      toggleFollow(market);
      render();
    });

    if (!isDetailPage) {
      entryForm.hidden = true;
      resolveRow.hidden = true;
      ledger.hidden = true;
      inviteRead.hidden = true;
      terms.hidden = true;

      const detailLink = document.createElement("a");
      detailLink.className = "primary-button action-link compact-button detail-link";
      detailLink.href = `detail.html?id=${market.id}`;
      detailLink.textContent = "View Bet";
      card.querySelector(".card-topline").append(detailLink);
    }

    amountInput.min = market.minStake;
    amountInput.placeholder = `$${market.minStake}+`;

    const updateQuote = () => {
      const amount = Number(amountInput.value);
      const blockReason = joinFormBlockReason(market, amount);
      quoteOutput.textContent = blockReason || quoteRead(market, sideSelect.value, amount);
      joinButton.disabled = Boolean(blockReason);
      joinButton.textContent = timeline.canJoin ? "Join" : "Betting closed";
    };

    const existingSide = sideForCurrentUser(market);
    if (existingSide) {
      sideSelect.value = existingSide;
      sideSelect.disabled = true;
    }
    if (!timeline.canJoin) {
      sideSelect.disabled = true;
      amountInput.disabled = true;
    }
    updateQuote();
    sideSelect.addEventListener("change", updateQuote);
    amountInput.addEventListener("input", updateQuote);

    if (isDetailPage) entryForm.hidden = market.status !== "OPEN" && market.status !== "";
    entryForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const amount = Number(amountInput.value);
      const joinMessage = joinFormBlockReason(market, amount);
      if (joinMessage) {
        setConnection(joinMessage, "error");
        return;
      }

      const entry = {
        id: crypto.randomUUID(),
        person: currentDisplayName(),
        side: sideSelect.value,
        amount
      };

      const existingEntrySide = sideForCurrentUser(market, entry.person);
      if (existingEntrySide && existingEntrySide !== entry.side) {
        setConnection(`You are already on ${existingEntrySide}. You can add more there, but you cannot switch sides.`, "error");
        return;
      }

      if (isSharedMode) {
        await createSharedEntry(market, entry);
      } else {
        entry.lockedPayout = quoteLockedPayout(market, entry.side, entry.amount);
        entry.lockedProfit = entry.lockedPayout - entry.amount;
        market.entries.push(entry);
        saveLocalMarkets();
        render();
      }
    });

    if (resolveActions) resolveActions.hidden = !isOwner;
    resolveButtons.forEach((button) => {
      button.disabled = !(isOwner && timeline.canResolve);
      button.addEventListener("click", async () => {
        if (isSharedMode) {
          await resolveSharedMarket(market, button.dataset.outcome);
        } else {
          market.status = "SETTLED";
          market.outcome = button.dataset.outcome;
          saveLocalMarkets();
          render();
        }
      });
    });

    renderLedger(card.querySelector(".ledger-body"), market);
    marketList.append(card);
  });
}

function renderLedger(container, market) {
  container.replaceChildren();

  if (market.entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "terms";
    empty.textContent = "No entries yet.";
    container.append(empty);
    return;
  }

  market.entries.forEach((entry) => {
    const payout = getPayout(market, entry);
    const lockedPayout = entry.lockedPayout || quoteLockedPayout(market, entry.side, entry.amount);
    const row = document.createElement("div");
    row.className = "ledger-row";
    row.innerHTML = `
      <strong>${escapeHtml(entry.person)}</strong>
      <span>${entry.side}</span>
      <span>${money.format(entry.amount)}</span>
      <span>${payout === null ? `Locked ${money.format(lockedPayout)} if wins` : `${money.format(payout)} payout`}</span>
    `;
    container.append(row);
  });
}

function formatDate(value) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(value));
}

function toLocalInputDate(value) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function formatProbability(share) {
  if (!Number.isFinite(share) || share <= 0) return "No line";
  return `${Math.round(share * 100)}%`;
}

function walletTransactionLabel(type) {
  return {
    INITIAL_GRANT: "Starting credits",
    STAKE: "Stake placed",
    PAYOUT: "Payout credited",
    REFUND: "Stake refunded"
  }[type] || "Wallet update";
}

function renderInviteRead(card, market) {
  const inviteRead = card.querySelector(".invite-read");
  if (market.visibility !== "INVITE_ONLY") {
    inviteRead.classList.remove("visible");
    inviteRead.textContent = "";
    return;
  }

  inviteRead.classList.add("visible");
  inviteRead.textContent = `Invite code: ${market.inviteCode}`;
}

function createInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  saveInviteCode(code);
  return code;
}

function payoutRead(market) {
  const pools = getPools(market);
  const odds = getOdds(market);
  const timeline = getTimelineState(market);
  if (market.outcome === "VOID") return `Void resolved${market.settledAt ? ` ${formatDate(market.settledAt)}` : ""}. All stakes return as test credits.`;
  if (market.outcome) {
    const retained = Number(market.settlementFeeTotal || 0);
    return `${market.outcome} resolved${market.settledAt ? ` ${formatDate(market.settledAt)}` : ""}. Winners were credited; ${money.format(retained)} retained as virtual fees/unallocated credits.`;
  }
  if (timeline.canResolve) return "Event deadline passed. Waiting for the umpire to resolve the result.";
  if (timeline.bettingClosed) return "Betting is closed. Existing entries are locked until the result is decided.";
  if (!pools.gross) return "Market line will appear once friends join.";
  return `Pools: YES ${money.format(pools.yes)} / NO ${money.format(pools.no)}. Line: YES ${formatProbability(odds.yesShare)} / NO ${formatProbability(odds.noShare)} implied.`;
}

function marketStatusLabel(market, timeline = getTimelineState(market)) {
  if (market.outcome) return `${market.outcome} resolved`;
  if (market.status === "SETTLED") return "Settled";
  if (timeline.canResolve) return "Awaiting result";
  if (timeline.bettingClosed) return "Betting closed";
  return "Open";
}

function validateMarket(market) {
  const cutoff = new Date(market.cutoff);
  const deadline = new Date(market.deadline);
  const now = new Date();

  if (!market.question) return "Add a clear question before creating the bet.";
  if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) return "Choose a valid betting cutoff.";
  if (!(deadline instanceof Date) || Number.isNaN(deadline.getTime())) return "Choose a valid event deadline.";
  if (cutoff <= now) return "The betting cutoff needs to be in the future.";
  if (deadline <= cutoff) return "The event deadline needs to be after the betting cutoff.";
  if (!market.umpire) return "Add an umpire so everyone knows who resolves the outcome.";
  if (market.minStake < 1) return "Minimum stake must be at least $1.";
  return "";
}

function setConnection(message, state) {
  if (!connectionStatus) return;
  connectionStatus.textContent = message;
  connectionStatus.classList.toggle("live", state === "live");
  connectionStatus.classList.toggle("error", state === "error");
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[character];
  });
}
