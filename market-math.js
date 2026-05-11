(function attachMarketMath(root, factory) {
  const math = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = math;
  } else {
    root.PeerPressureMath = math;
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function createMarketMath() {
  function numeric(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function getPools(market) {
    const entries = Array.isArray(market.entries) ? market.entries : [];
    const yes = entries
      .filter((entry) => entry.side === "YES")
      .reduce((sum, entry) => sum + numeric(entry.amount), 0);
    const no = entries
      .filter((entry) => entry.side === "NO")
      .reduce((sum, entry) => sum + numeric(entry.amount), 0);
    const gross = yes + no;
    const feeRate = (numeric(market.platformFee) + numeric(market.oddsRake)) / 100;
    const net = market.outcome === "VOID" ? gross : gross * (1 - feeRate);

    return { yes, no, gross, net, feeRate };
  }

  function getOdds(market) {
    const pools = getPools(market);
    return {
      yesOdds: pools.yes > 0 ? pools.net / pools.yes : 0,
      noOdds: pools.no > 0 ? pools.net / pools.no : 0,
      yesShare: pools.gross > 0 ? pools.yes / pools.gross : 0,
      noShare: pools.gross > 0 ? pools.no / pools.gross : 0
    };
  }

  function losingPoolForSide(market, side) {
    const pools = getPools(market);
    return side === "YES" ? pools.no : pools.yes;
  }

  function quoteLockedPayout(market, side, amount) {
    const stake = numeric(amount);
    const pools = getPools(market);
    const samePool = side === "YES" ? pools.yes : pools.no;
    const oppositePool = side === "YES" ? pools.no : pools.yes;
    const profit = oppositePool > 0
      ? (stake / (samePool + stake)) * oppositePool * (1 - pools.feeRate)
      : 0;

    return stake + profit;
  }

  function getPayout(market, entry) {
    if (!market.outcome) return null;
    if (market.outcome === "VOID") return numeric(entry.amount);
    if (entry.side !== market.outcome) return 0;
    if (numeric(entry.lockedPayout) > 0) return numeric(entry.lockedPayout);

    const pools = getPools(market);
    const winningPool = market.outcome === "YES" ? pools.yes : pools.no;
    return winningPool > 0
      ? numeric(entry.amount) + (numeric(entry.amount) / winningPool) * losingPoolForSide(market, entry.side) * (1 - pools.feeRate)
      : numeric(entry.amount);
  }

  function settlementSummary(market, outcome) {
    const entries = Array.isArray(market.entries) ? market.entries : [];
    const settledMarket = { ...market, outcome };
    const gross = getPools(settledMarket).gross;
    const credited = entries.reduce((sum, entry) => {
      return sum + getPayout(settledMarket, entry);
    }, 0);

    return {
      gross,
      credited,
      retained: Math.max(0, gross - credited)
    };
  }

  return {
    getPools,
    getOdds,
    getPayout,
    quoteLockedPayout,
    losingPoolForSide,
    settlementSummary
  };
});
