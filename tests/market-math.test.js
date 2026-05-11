const assert = require("node:assert/strict");
const {
  getPools,
  getPayout,
  quoteLockedPayout,
  settlementSummary
} = require("../market-math");

function approx(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);
}

const baseMarket = {
  platformFee: 2,
  oddsRake: 3,
  outcome: "",
  entries: []
};

approx(quoteLockedPayout(baseMarket, "YES", 10), 10, "first bettor receives stake-only locked payout");

const oneSidedMarket = {
  ...baseMarket,
  entries: [
    { side: "YES", amount: 10, lockedPayout: 10 }
  ]
};

approx(quoteLockedPayout(oneSidedMarket, "YES", 5), 5, "same-side add-on has no profit before opposing pool");
approx(quoteLockedPayout(oneSidedMarket, "NO", 10), 19.5, "opposing bettor locks proportional payout less fee");

const liveMarket = {
  ...baseMarket,
  entries: [
    { side: "YES", amount: 10, lockedPayout: 10 },
    { side: "NO", amount: 10, lockedPayout: 19.5 },
    { side: "YES", amount: 5, lockedPayout: 8.166666666666668 }
  ]
};

assert.deepEqual(getPools(liveMarket), {
  yes: 15,
  no: 10,
  gross: 25,
  net: 23.75,
  feeRate: 0.05
});

const yesSettled = { ...liveMarket, outcome: "YES" };
approx(getPayout(yesSettled, liveMarket.entries[0]), 10, "YES winner receives locked payout");
approx(getPayout(yesSettled, liveMarket.entries[1]), 0, "loser receives no payout");
approx(getPayout(yesSettled, liveMarket.entries[2]), 8.166666666666668, "later YES stake keeps locked quote");

const voidSettled = { ...liveMarket, outcome: "VOID" };
approx(getPayout(voidSettled, liveMarket.entries[0]), 10, "void returns first stake");
approx(getPayout(voidSettled, liveMarket.entries[1]), 10, "void returns opposing stake");

const noSummary = settlementSummary(liveMarket, "NO");
approx(noSummary.gross, 25, "settlement gross totals all stakes");
approx(noSummary.credited, 19.5, "settlement credits locked winning payouts");
approx(noSummary.retained, 5.5, "settlement retained amount is uncredited test credits");

console.log("market math tests passed");
