// Python's sorted()/str comparison is codepoint-based (case-sensitive, uppercase before
// lowercase). JS's default String#localeCompare is locale-aware and sorts differently
// (e.g. "Account Payable" vs "AKUMULASI..." order flips). Use this wherever a sort must
// match a ported Python `sorted(x, key=...)` call.
export function codepointCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
