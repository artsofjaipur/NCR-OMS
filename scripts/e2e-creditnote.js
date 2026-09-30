/* E2E: credit note with bill linkage → ledger reflection (company 1 probe account). */
const BASE = process.env.BASE || "http://localhost:3000";
const EMAIL = "buffy.probe@test.com";
const PASS = "newpass456";

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("PASS:", name);
  else { failures++; console.log("FAIL:", name, extra !== undefined ? JSON.stringify(extra) : ""); }
}

async function req(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* 204 */ }
  return { status: res.status, data };
}

async function main() {
  // 1. Login
  const login = await req("POST", "/auth/login", { email: EMAIL, password: PASS });
  check("login ok", login.status === 200 && login.data.token, login.data);
  const token = login.data.token;
  const companyId = login.data.companyId;

  // 2. Parties list
  const parties = await req("GET", "/finance/parties", null, token);
  check("parties loaded", parties.status === 200 && Array.isArray(parties.data) && parties.data.length > 0, parties.data);
  const party = parties.data[0];
  console.log("  party:", party.id, party.name, "balance", party.balance);

  // 3. Bills list (need a bill id)
  const bills = await req("GET", "/finance/bills", null, token);
  check("bills loaded", bills.status === 200 && Array.isArray(bills.data), bills.data);
  const bill = bills.data.find((b) => b.supplierId === party.id) || bills.data[0];
  console.log("  bill:", bill && bill.id, bill && bill.invoiceNumber, "total", bill && bill.total);

  const suffix = Date.now().toString().slice(-8);
  const noteNo = "CN-E2E-" + suffix;

  // 4. Create credit note WITH bill linkage
  const cn = await req("POST", "/finance/notes/credit", {
    supplierId: party.id,
    purchaseEntryId: bill ? bill.id : undefined,
    noteNumber: noteNo,
    amount: "100.00",
    reason: "AWB 876499947613 adjustment e2e",
  }, token);
  check("credit note created (with bill linkage)", cn.status === 201, cn.data);
  const noteId = cn.data && cn.data.id;

  // 5. Ledger shows the note with bill ref + running balance
  const ledger = await req("GET", "/finance/ledger?supplierId=" + party.id, null, token);
  check("ledger loaded", ledger.status === 200 && Array.isArray(ledger.data.entries), ledger.data);
  const entry = ledger.data.entries.find((e) => e.type === "CREDIT_NOTE" && e.ref === noteNo);
  check("ledger contains CREDIT_NOTE entry", !!entry, ledger.data.entries.map((e) => e.type + ":" + e.ref));
  if (entry && bill) {
    check("ledger entry references the bill", String(entry.detail).includes(bill.invoiceNumber || "#" + bill.id), entry.detail);
  }
  // Re-fetch parties AFTER note creation — balance must equal ledger closing at the same instant.
  const parties2 = await req("GET", "/finance/parties", null, token);
  const party2 = parties2.data.find((p) => p.id === party.id);
  check("ledger closing = party balance (consistency)", party2 && Number(ledger.data.closing).toFixed(2) === Number(party2.balance).toFixed(2), { closing: ledger.data.closing, partyBal: party2 && party2.balance });

  // 6. Note listed in notes endpoint
  const notes = await req("GET", "/finance/notes?type=credit", null, token);
  const listed = notes.data.find((n) => n.id === noteId);
  check("note listed in /notes", !!listed, notes.data && notes.data.length);

  // 7. Duplicate note number → 409
  const dup = await req("POST", "/finance/notes/credit", { supplierId: party.id, noteNumber: noteNo, amount: "50.00" }, token);
  check("duplicate note number → 409", dup.status === 409, dup.status);

  // 8. Cleanup: delete test note
  const del = await req("DELETE", "/finance/notes/credit/" + noteId, null, token);
  check("cleanup: note deleted", del.status === 204, del.status);
  const ledger2 = await req("GET", "/finance/ledger?supplierId=" + party.id, null, token);
  check("ledger no longer contains note after delete", !ledger2.data.entries.find((e) => e.ref === noteNo));

  console.log(failures === 0 ? "\nALL E2E CHECKS PASSED ✅" : "\n" + failures + " CHECK(S) FAILED ❌");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
