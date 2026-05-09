import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AUDIT_REDACTED = "[REDACTED]";

const APP_DIR_NAME = "SemiAutoCexTerminal";
const DEFAULT_FILE_NAME = "order-audit.jsonl";
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 200;
const MAX_STRING_LENGTH = 4000;

const SENSITIVE_KEY_PATTERNS = [
  /(^|[_-])api[_-]?key($|[_-])/i,
  /(^|[_-])api[_-]?secret($|[_-])/i,
  /(^|[_-])secret($|[_-])/i,
  /(^|[_-])signature($|[_-])/i,
  /signature/i,
  /(^|[_-])private[_-]?key($|[_-])/i,
  /(^|[_-])orderly[_-]?key($|[_-])/i,
  /(^|[_-])orderly[_-]?secret($|[_-])/i,
  /(^|[_-])account[_-]?id($|[_-])/i,
  /(^|[_-])listen[_-]?key($|[_-])/i,
  /(^|[_-])authorization($|[_-])/i,
  /(^|[_-])cookie($|[_-])/i,
  /(^|[_-])token($|[_-])/i,
  /(^|[_-])credentials($|[_-])/i,
  /(^|[_-])session($|[_-])/i,
  /(^|[_-])session[_-]?(config|env|raw|data)($|[_-])/i,
  /(^|[_-])raw[_-]?session/i
];

const QUERY_SECRET_PATTERN = /([?&;]\s*(?:api[_-]?key|api[_-]?secret|account[_-]?id|signature|orderly[_-]?(?:key|signature)|private[_-]?key|listen[_-]?key|token|authorization)=)[^&;\s]*/gi;
const ENV_SECRET_PATTERN = /((?:^|\n)\s*(?:API[_-]?KEY|API[_-]?SECRET|ACCOUNT[_-]?ID|SIGNATURE|ORDERLY[_-]?(?:KEY|SECRET)|PRIVATE[_-]?KEY|LISTEN[_-]?KEY|TOKEN|AUTHORIZATION)\s*=\s*)[^\r\n]*/gi;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function defaultAuditLogPath(appName = APP_DIR_NAME) {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, appName, "logs", DEFAULT_FILE_NAME);
  }

  if (process.env.XDG_STATE_HOME) {
    return path.join(process.env.XDG_STATE_HOME, appName, "logs", DEFAULT_FILE_NAME);
  }

  if (os.homedir()) {
    return path.join(os.homedir(), ".local", "state", appName, "logs", DEFAULT_FILE_NAME);
  }

  return path.resolve("runtime", appName, "logs", DEFAULT_FILE_NAME);
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(String(key)));
}

function stableKnownSecrets(knownSecrets = []) {
  return Array.from(new Set(
    knownSecrets
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length >= 4)
      .sort((left, right) => right.length - left.length)
  ));
}

function redactString(value, knownSecrets) {
  let redacted = value
    .replace(PRIVATE_KEY_BLOCK_PATTERN, AUDIT_REDACTED)
    .replace(QUERY_SECRET_PATTERN, `$1${AUDIT_REDACTED}`)
    .replace(ENV_SECRET_PATTERN, `$1${AUDIT_REDACTED}`);

  for (const secret of knownSecrets) {
    redacted = redacted.split(secret).join(AUDIT_REDACTED);
  }

  if (redacted.length > MAX_STRING_LENGTH) {
    return `${redacted.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
  }

  return redacted;
}

function redactValue(value, options, seen, depth) {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactString(value, options.knownSecrets);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= MAX_DEPTH) {
    return "[MaxDepth]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => (
      redactValue(item, options, seen, depth + 1)
    ));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    seen.delete(value);
    return items;
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveKey(key)
      ? AUDIT_REDACTED
      : redactValue(item, options, seen, depth + 1);
  }

  seen.delete(value);
  return output;
}

export function redactAuditData(value, { knownSecrets = [] } = {}) {
  return redactValue(value, { knownSecrets: stableKnownSecrets(knownSecrets) }, new WeakSet(), 0);
}

export function createAuditLogger({ filePath = defaultAuditLogPath(), now = () => new Date() } = {}) {
  const resolvedPath = path.resolve(filePath);

  return {
    filePath: resolvedPath,

    write(event, payload = {}, options = {}) {
      if (!event || typeof event !== "string") {
        throw new TypeError("Audit event name must be a non-empty string");
      }

      const record = {
        version: 1,
        time: now().toISOString(),
        event,
        severity: options.severity || "info",
        payload: redactAuditData(payload, { knownSecrets: options.knownSecrets || [] })
      };

      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.appendFileSync(resolvedPath, `${JSON.stringify(record)}\n`, "utf8");
      return record;
    }
  };
}
