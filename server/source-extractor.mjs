import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

const MAX_URL_LENGTH = 2_048;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 15_000;
const DNS_TIMEOUT_MS = 3_000;
const ACCEPTED_TYPES = new Map([
  ["text/html", "text/html"],
  ["application/xhtml+xml", "application/xhtml+xml"],
  ["text/plain", "text/plain"],
]);

function ipv4ToNumber(address) {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
  return parts.reduce((value, part) => (value << 8) | Number(part), 0) >>> 0;
}

function inIpv4Range(address, base, bits) {
  const value = ipv4ToNumber(address);
  const network = ipv4ToNumber(base);
  if (value === undefined || network === undefined) return true;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv4IsPublic(address) {
  if (isIP(address) !== 4) return false;
  const denied = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !denied.some(([base, bits]) => inIpv4Range(address, base, bits));
}

function ipv6ToBigInt(address) {
  if (typeof address !== "string" || address.includes("%")) return undefined;
  let normalized = address.toLowerCase();

  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const embedded = ipv4ToNumber(normalized.slice(lastColon + 1));
    if (embedded === undefined) return undefined;
    const high = ((embedded >>> 16) & 0xffff).toString(16);
    const low = (embedded & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6IsPublic(address) {
  if (isIP(address) !== 6) return false;
  const value = ipv6ToBigInt(address);
  if (value === undefined) return false;
  const first16 = Number((value >> 112n) & 0xffffn);
  const second16 = Number((value >> 96n) & 0xffffn);
  const first32 = Number((value >> 96n) & 0xffffffffn);

  // Only global unicast is accepted. Exclude special transition and documentation blocks.
  if ((first16 & 0xe000) !== 0x2000) return false;
  if (first16 === 0x2001 && second16 <= 0x01ff) return false; // 2001::/23 special-purpose
  if (first32 === 0x20010db8) return false; // 2001:db8::/32 documentation
  if (first16 === 0x2002) return false; // 6to4 can embed non-public IPv4 destinations
  if (first16 === 0x3fff && second16 <= 0x0fff) return false; // 3fff::/20 documentation
  return true;
}

function addressIsPublic(address) {
  return isIP(address) === 4 ? ipv4IsPublic(address) : isIP(address) === 6 ? ipv6IsPublic(address) : false;
}

function validateUrl(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > MAX_URL_LENGTH) {
    throw new Error("invalid_url");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_url");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !host ||
    host.endsWith(".") ||
    isIP(host) !== 0 ||
    host === "localhost" ||
    [".localhost", ".local", ".internal", ".lan", ".test", ".invalid", ".example", ".home.arpa"].some((suffix) => host.endsWith(suffix))
  ) {
    throw new Error("unsupported_url");
  }
  return url;
}

async function resolvePinnedAddress(host) {
  let timer;
  const answers = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("dns_timeout")), DNS_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 32) throw new Error("dns_failed");
  if (answers.some((answer) => !addressIsPublic(answer.address))) throw new Error("non_public_address");
  const selected = answers.find((answer) => answer.family === 4) ?? answers[0];
  if (!selected || !addressIsPublic(selected.address)) throw new Error("non_public_address");
  return { address: selected.address, family: selected.family };
}

function pinnedLookup(address) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

function fetchHttps(url, pinnedAddress, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
          "accept-encoding": "identity",
          "user-agent": "Sprintline-local/0.1",
        },
        lookup: pinnedLookup(pinnedAddress),
        servername: url.hostname,
        rejectUnauthorized: true,
        agent: false,
        maxHeaderSize: 16 * 1024,
        signal: AbortSignal.timeout(timeoutMs),
      },
      resolve,
    );
    request.on("error", () => reject(new Error("source_fetch_failed")));
    request.end();
  });
}

async function readLimited(response, maxBytes) {
  const contentLength = Number(response.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.destroy();
    throw new Error("source_too_large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) {
      response.destroy();
      throw new Error("source_too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d{1,7});/g, (_match, digits) => {
      const codePoint = Number(digits);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_match, digits) => {
      const codePoint = Number.parseInt(digits, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : " ";
    });
}

function redact(text, maxLength) {
  return text
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email removed]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[link removed]")
    .replace(/\b(password|passcode|passwd|api\s*key|secret|access\s*token)\s*[:=]\s*[^\s,;]+/gi, "$1 [removed]")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n[ \n]+/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function attribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

export function extractHtml(source) {
  // Only public Event scheduling fields leave structured page data. Never retain
  // arbitrary hydration state, attendee data, or instructions from scripts.
  const scheduleLines = [];
  for (const script of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = script[1] ?? "";
    if (attribute(attrs, "type") !== "application/ld+json" && attribute(attrs, "id") !== "__NEXT_DATA__") continue;
    let data;
    try { data = JSON.parse(script[2]); } catch { continue; }
    let visited = 0;
    function visit(value, depth = 0) {
      if (!value || typeof value !== "object" || depth > 14 || ++visited > 4000) return;
      const isEvent = value["@type"] === "Event" || (typeof value.start_at === "string" && typeof value.timezone === "string" && typeof value.name === "string");
      if (isEvent) {
        const start = value.startDate ?? value.start_at;
        const zone = value.timezone;
        if (typeof zone === "string" && /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(zone)) {
          try {
            new Intl.DateTimeFormat("en", { timeZone: zone });
            scheduleLines.push(`Time zone: ${zone}`);
            if (typeof start === "string" && Number.isFinite(Date.parse(start))) {
              const date = new Date(start);
              const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
              const part = (type) => parts.find((item) => item.type === type)?.value;
              scheduleLines.push(`Event date: ${part("year")}-${part("month")}-${part("day")}`);
              const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
              scheduleLines.push(`Event starts at ${time}`);
            }
          } catch { /* Invalid source timezone remains unknown. */ }
        } else if (typeof start === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(start) && Number.isFinite(Date.parse(start))) {
          // The offset preserves the source's local wall time; it does not prove an IANA zone.
          scheduleLines.push(`Event date: ${start.slice(0, 10)}`, `Event starts at ${start.slice(11, 16)}`);
        }
      }
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
    visit(data);
  }
  const title = decodeEntities(source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let description = "";
  let socialTitle = "";
  for (const match of source.matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = match[1] ?? "";
    const name = attribute(attributes, "name").toLowerCase();
    const property = attribute(attributes, "property").toLowerCase();
    const content = attribute(attributes, "content");
    if (name === "description" || property === "og:description") description ||= content;
    if (property === "og:title") socialTitle ||= content;
  }

  const bodySource = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|form|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|form|nav|footer|header|aside)\b[^>]*\/?\s*>/gi, " ")
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|section|article|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const visibleText = decodeEntities(bodySource).replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ").replace(/[^\S\n]+/g, " ").trim();
  return {
    title: redact(title || socialTitle, 300),
    description: redact(description, 800),
    text: redact([...new Set(scheduleLines), title || socialTitle, description, visibleText].filter(Boolean).join("\n"), 12_000),
  };
}

function safeDisplayUrl(url) {
  const display = new URL(url);
  return display.origin;
}

export async function extractPublicEventPage(rawUrl) {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let current = validateUrl(rawUrl);
  let response;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    current = validateUrl(current.toString());
    const pinnedAddress = await resolvePinnedAddress(current.hostname);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("source_timeout");
    response = await fetchHttps(current, pinnedAddress, Math.min(6_000, remaining));

    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirectCount === MAX_REDIRECTS) throw new Error("source_redirect_limit");
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error("source_redirect_invalid");
      }
      current = validateUrl(next.toString());
      continue;
    }
    if (status !== 200) {
      response.destroy();
      throw new Error("source_unavailable");
    }
    break;
  }

  if (!response) throw new Error("source_unavailable");
  const rawType = String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const contentType = ACCEPTED_TYPES.get(rawType);
  const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
  if (!contentType || (encoding && encoding !== "identity")) {
    response.destroy();
    throw new Error("unsupported_content_type");
  }

  const body = await readLimited(response, MAX_RESPONSE_BYTES);
  const page = contentType === "text/plain"
    ? { title: "", description: "", text: redact(body, 12_000) }
    : extractHtml(body);
  if (page.text.length < 80) throw new Error("unsupported_page");

  return {
    url: safeDisplayUrl(current),
    title: page.title,
    description: page.description,
    text: page.text,
    contentType,
  };
}
