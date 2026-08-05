// Scratch file (gitignored). Past live probes on the paper account:
// - fractional-size bracket → IBKR error 10243 (API hard block)
// - cashQty stock order → IBKR error 10244 (cash quantity not usable)
// Decision 2026-08-05: dexter trades whole shares; fractional code stays
// dormant (fractional_shares: false in both risk-rules profiles).
export {};
