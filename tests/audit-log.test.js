import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AUDIT_REDACTED, createAuditLogger, redactAuditData } from "../src/audit-log.js";

test("audit redaction removes credentials, account ids, signatures, sessions, and private keys", () => {
  const redacted = redactAuditData({
    apiKey: "ak_test_should_not_persist",
    apiSecret: "sec_test_should_not_persist",
    accountId: "acct_test_should_not_persist",
    orderlySignature: "sig_test_should_not_persist",
    privateKey: "-----BEGIN PRIVATE KEY-----\nkey-body\n-----END PRIVATE KEY-----",
    rawSessionConfig: "API_KEY=ak_test_should_not_persist\nTRADING_MODE=live",
    nested: {
      symbol: "BTCUSDC",
      credentials: {
        apiKey: "nested_key_should_not_persist"
      },
      url: "https://example.invalid/v1/order?signature=query_sig_should_not_persist&symbol=BTCUSDC",
      memo: "known-secret-value appears in this string"
    }
  }, {
    knownSecrets: ["known-secret-value"]
  });

  assert.equal(redacted.apiKey, AUDIT_REDACTED);
  assert.equal(redacted.apiSecret, AUDIT_REDACTED);
  assert.equal(redacted.accountId, AUDIT_REDACTED);
  assert.equal(redacted.orderlySignature, AUDIT_REDACTED);
  assert.equal(redacted.privateKey, AUDIT_REDACTED);
  assert.equal(redacted.rawSessionConfig, AUDIT_REDACTED);
  assert.equal(redacted.nested.symbol, "BTCUSDC");
  assert.equal(redacted.nested.credentials, AUDIT_REDACTED);

  const serialized = JSON.stringify(redacted);
  for (const forbidden of [
    "ak_test_should_not_persist",
    "sec_test_should_not_persist",
    "acct_test_should_not_persist",
    "sig_test_should_not_persist",
    "key-body",
    "query_sig_should_not_persist",
    "known-secret-value",
    "nested_key_should_not_persist"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(serialized.includes("BTCUSDC"), true);
});

test("audit logger writes representative order lifecycle events as JSONL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "order-audit-test-"));
  const filePath = path.join(dir, "audit.jsonl");
  const logger = createAuditLogger({
    filePath,
    now: () => new Date("2026-05-09T00:00:00.000Z")
  });

  try {
    logger.write("order.submit", {
      exchangeId: "mememax-orderly",
      mode: "dry-run",
      symbol: "BTCUSDC",
      action: "OPEN",
      response: {
        orderId: "1001",
        accountId: "acct_lifecycle_should_not_persist"
      }
    }, {
      knownSecrets: ["acct_lifecycle_should_not_persist"]
    });

    logger.write("order.chase.replace", {
      exchangeId: "mememax-orderly",
      mode: "dry-run",
      jobId: "chase_1",
      orderId: "1001",
      targetPrice: 65000,
      response: {
        orderId: "1001",
        status: "EDIT_SENT",
        signature: "replace_sig_should_not_persist"
      }
    });

    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, "order.submit");
    assert.equal(lines[0].time, "2026-05-09T00:00:00.000Z");
    assert.equal(lines[0].payload.response.accountId, AUDIT_REDACTED);
    assert.equal(lines[1].event, "order.chase.replace");
    assert.equal(lines[1].payload.response.signature, AUDIT_REDACTED);

    const serialized = fs.readFileSync(filePath, "utf8");
    assert.equal(serialized.includes("acct_lifecycle_should_not_persist"), false);
    assert.equal(serialized.includes("replace_sig_should_not_persist"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
