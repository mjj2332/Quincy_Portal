import { COLLECTION_KINDS, type CollectionKind } from "./media";

export type TonomoServiceKind = Extract<CollectionKind, "raw" | "video" | "floorplan" | "copy">;

export interface TonomoOrder {
  orderId: string;
  orderNo: string | null;
  street: string;
  suburb: string | null;
  postcode: string | null;
  agentName: string | null;
  agentEmail: string | null;
  agentPhone: string | null;
  agencyName: string | null;
  shootDate: string | null;
  timeWindow: string | null;
  /** Undefined means Tonomo omitted the field; null means it explicitly cleared it. */
  invoiceAmount: number | null | undefined;
  /** Undefined means Tonomo omitted the field; null means it explicitly cleared it. */
  paymentStatus: string | null | undefined;
  notes: string | null;
  rawFolderLink: string | null;
  rawFolderPath: string | null;
  photographerEmails: string[];
  services: { kind: TonomoServiceKind; url: string | null; label: string | null }[];
  unrecognisedServices: string[];
}

export class TonomoParseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TonomoParseError";
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function valueFor(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

function optionalString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function optionalHttpUrl(value: unknown): string | null {
  const url = optionalString(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch { return null; }
}

function requiredString(value: unknown, reason: string): string {
  const result = optionalString(value);
  if (!result) throw new TonomoParseError(reason);
  return result;
}

const tonomoOrderIdKeys = ["order_id", "orderId", "id"] as const;
const tonomoEnvelopeOrderIdKeys = ["order_id", "orderId"] as const;
const tonomoOrderNoKeys = ["orderNo", "order_no", "reference"] as const;

function consistentOrderId(source: UnknownRecord, keys: readonly string[], reason: string): string | null {
  let identity: string | null = null;
  for (const key of keys) {
    if (source[key] === undefined || source[key] === null) continue;
    const value = optionalString(source[key]);
    if (!value) continue;
    if (identity !== null && identity !== value) throw new TonomoParseError(reason);
    identity = value;
  }
  return identity;
}

/**
 * Unwraps the one provider envelope that changes the order shape. Tonomo's
 * changed notification has an appointment id at the root, so only an object
 * explicitly marked as changed may use its nested order as the source.
 */
export function normaliseTonomoPayload(payload: unknown): Record<string, unknown> {
  const candidate = Array.isArray(payload) ? payload[0] : payload;
  const source = record(candidate);
  if (!source) throw new TonomoParseError("payload must contain an order object");
  if (source.action !== "changed") return source;

  const nestedOrder = record(source.order);
  if (!nestedOrder) throw new TonomoParseError("changed webhook must contain an order object");
  const outerOrderId = consistentOrderId(
    source,
    tonomoEnvelopeOrderIdKeys,
    "changed webhook has conflicting outer order ids",
  );
  if (!outerOrderId) throw new TonomoParseError("changed webhook missing required order id");
  const nestedOrderId = consistentOrderId(
    nestedOrder,
    tonomoOrderIdKeys,
    "changed webhook has conflicting nested order ids",
  );
  if (!nestedOrderId) throw new TonomoParseError("changed webhook nested order missing required order id");
  if (outerOrderId !== nestedOrderId) {
    throw new TonomoParseError("changed webhook order id conflicts with nested order id");
  }
  return nestedOrder;
}

/** Returns the stable identity used by ingress deduplication for an order payload. */
export function tonomoOrderKey(payload: unknown): string | undefined {
  const source = normaliseTonomoPayload(payload);
  return optionalString(valueFor(source, tonomoOrderIdKeys))
    ?? optionalString(valueFor(source, tonomoOrderNoKeys))
    ?? undefined;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function serviceKind(name: string): TonomoServiceKind | null {
  const normalised = name.toLowerCase().trim().replace(/[ _-]+/g, " ");
  if (normalised === "listing images" || normalised.includes("image") || normalised.includes("photo")) return "raw";
  if (normalised.includes("floorplan") || normalised.includes("floor plan")) return "floorplan";
  if (normalised.startsWith("copywriting") || normalised.startsWith("copy")) return "copy";
  if (normalised.includes("video") || normalised.includes("footage") || normalised.includes("reel") || normalised.includes("film")) return "video";
  return null;
}

function parseServices(value: unknown): Pick<TonomoOrder, "services" | "unrecognisedServices"> {
  if (value === undefined || value === null) return { services: [], unrecognisedServices: [] };
  if (!Array.isArray(value)) throw new TonomoParseError("services must be an array when provided");
  const services: TonomoOrder["services"] = [];
  const unrecognisedServices: string[] = [];
  for (const item of value) {
    const details = record(item);
    const name = typeof item === "string"
      ? item
      : details ? optionalString(valueFor(details, ["type", "service", "name"])) : null;
    if (!name) {
      unrecognisedServices.push("(unnamed service)");
      continue;
    }
    const kind = serviceKind(name);
    if (!kind || !(COLLECTION_KINDS as readonly string[]).includes(kind)) {
      unrecognisedServices.push(name);
      continue;
    }
    services.push({
      kind,
      url: details ? optionalHttpUrl(valueFor(details, ["url", "link", "delivery_url"])) : null,
      label: name,
    });
  }
  return { services, unrecognisedServices };
}

function appendService(
  parsed: Pick<TonomoOrder, "services" | "unrecognisedServices">,
  name: string,
  url: string | null,
): void {
  const kind = serviceKind(name);
  if (!kind || !(COLLECTION_KINDS as readonly string[]).includes(kind)) {
    parsed.unrecognisedServices.push(name);
    return;
  }
  parsed.services.push({ kind, url, label: name });
}

function parseDeliverableLinks(value: unknown, parsed: Pick<TonomoOrder, "services" | "unrecognisedServices">): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw new TonomoParseError("deliverablesLinks must be an array when provided");
  const absorbedKinds = new Set<TonomoServiceKind>();
  // Tonomo can list the same file under several share links (fixture B's reel appears
  // twice with distinct urls but one content_hash) — dedupe by content identity too.
  const seenHashes = new Set<string>();
  for (const item of value) {
    const details = record(item);
    if (!details) continue;
    const type = optionalString(details.type)?.toLowerCase() ?? null;
    if (type === "photos") continue;
    const contentHash = optionalString(details.content_hash);
    if (contentHash) {
      if (seenHashes.has(contentHash)) continue;
      seenHashes.add(contentHash);
    }
    const name = optionalString(details.name) ?? type;
    const kind = type === "floor plan" ? "floorplan"
      : type === "video" ? "video"
        : type === "pdf" ? serviceKind(name ?? "") ?? "copy"
          : serviceKind(name ?? "");
    if (!kind || !(COLLECTION_KINDS as readonly string[]).includes(kind)) {
      parsed.unrecognisedServices.push(name ?? "(unnamed deliverable)");
      continue;
    }
    const url = optionalHttpUrl(details.url);
    if (url && parsed.services.some((service) => service.url === url)) continue;
    const existing = !absorbedKinds.has(kind)
      ? parsed.services.find((service) => service.kind === kind && !service.url)
      : undefined;
    if (existing) {
      existing.url = url;
      existing.label = name;
    } else {
      parsed.services.push({ kind, url, label: name });
    }
    absorbedKinds.add(kind);
  }
}

function addressFromManual(value: unknown): string | null {
  const direct = optionalString(value);
  if (direct) return direct;
  const details = record(value);
  return details ? optionalString(valueFor(details, ["street", "address", "formatted_address", "formattedAddress"])) : null;
}

function addressFromOrderName(value: unknown): string | null {
  const name = optionalString(value);
  return name ? (name.split(" - ")[0]?.split(",")[0]?.trim() || null) : null;
}

function optionalNumberTriState(source: UnknownRecord, keys: readonly string[]): number | null | undefined {
  const value = valueForTriState(source, keys);
  if (value === undefined) return undefined;
  if (value === null) return null;
  return optionalNumber(value);
}

function optionalStringTriState(source: UnknownRecord, keys: readonly string[]): string | null | undefined {
  const value = valueForTriState(source, keys);
  if (value === undefined) return undefined;
  if (value === null) return null;
  return optionalString(value);
}

function valueForTriState(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) if (source[key] !== undefined) return source[key];
  return undefined;
}

function notesFrom(source: UnknownRecord): string | null {
  const fields = ["entry_notes", "order_notes", "property_feature_notes", "floor_plan_notes", "contact_notes"] as const;
  const notes = fields.flatMap((field) => {
    const value = optionalString(source[field]);
    return value && value !== "--" ? [`${field}: ${value}`] : [];
  });
  if (Array.isArray(source.customQuestions)) {
    for (const question of source.customQuestions) {
      const details = record(question);
      const value = optionalString(details?.value);
      if (!value) continue;
      const label = optionalString(details?.label);
      notes.push(label ? `${label} ${value}` : value);
    }
  }
  return notes.length ? notes.join("\n") : null;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isCanonicalCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

const TONOMO_DISPLAY_DATE_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const TONOMO_DISPLAY_DATE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const TONOMO_DISPLAY_DATE_PATTERN = new RegExp(`^(${TONOMO_DISPLAY_DATE_WEEKDAYS.join("|")}), (\\d{2}) (${TONOMO_DISPLAY_DATE_MONTHS.join("|")}), (\\d{4})$`);

/**
 * Tonomo's `created` webhook sometimes carries only a human-readable date such as
 * "Thursday, 17 Sep, 2026" instead of a `when.start_time` epoch. Parses that exact shape
 * into a canonical `YYYY-MM-DD`, validating both the calendar date and the weekday against
 * each other so a malformed or fabricated display string is rejected rather than silently
 * accepted. Returns null for anything else — including single-digit days, lowercase
 * months, or free text like "tomorrow" — so callers can fall back to keeping the raw text.
 */
export function parseTonomoDisplayDate(value: string): string | null {
  const match = TONOMO_DISPLAY_DATE_PATTERN.exec(value);
  if (!match) return null;
  const [, weekday, day, month, year] = match;
  const monthNumber = TONOMO_DISPLAY_DATE_MONTHS.indexOf(month as (typeof TONOMO_DISPLAY_DATE_MONTHS)[number]) + 1;
  const iso = `${year}-${String(monthNumber).padStart(2, "0")}-${day}`;
  if (!isCanonicalCalendarDate(iso)) return null;
  // setUTCFullYear keeps four-digit years literal; Date.UTC would remap 0000-0099 to 1900-1999.
  const civil = new Date(0);
  civil.setUTCFullYear(Number(year), monthNumber - 1, Number(day));
  const expectedWeekday = TONOMO_DISPLAY_DATE_WEEKDAYS[civil.getUTCDay()];
  return weekday === expectedWeekday ? iso : null;
}

function shootDateFrom(source: UnknownRecord, propertyAddress: UnknownRecord | null): string | null {
  const fallback = () => {
    const text = optionalString(valueFor(source, ["shoot_date", "shootDate", "date"]));
    if (text === null) return null;
    if (isCanonicalCalendarDate(text)) return text;
    return parseTonomoDisplayDate(text) ?? text;
  };
  const when = record(source.when);
  if (!when) return fallback();
  const startTime = optionalNumber(when.start_time);
  if (startTime === null) return fallback();
  const timeZone = optionalString(propertyAddress?.timezone) ?? "Australia/Sydney";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(startTime * 1_000));
    const part = (type: "year" | "month" | "day") => parts.find((item) => item.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    return year && month && day ? `${year}-${month}-${day}` : fallback();
  } catch {
    // Unknown/invalid IANA timezone — keep the human-readable date rather than losing it.
    return fallback();
  }
}

/** Normalises the subset of an address that Tonomo can reliably use for reconciliation. */
export function normaliseAddressKey(street: string, postcode: string | null | undefined): string {
  return `${street} ${postcode ?? ""}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTonomoOrder(payload: unknown): TonomoOrder {
  const source = normaliseTonomoPayload(payload);

  const orderId = requiredString(valueFor(source, ["order_id", "orderId", "id"]), "missing required order id");
  const propertyAddress = record(source.property_address);
  const street = optionalString(propertyAddress?.street)
    ?? optionalString(valueFor(propertyAddress ?? {}, ["formatted_address", "formattedAddress"]))
    ?? addressFromManual(source.manualPropertyAddress)
    ?? optionalString(source.street)
    ?? optionalString(source.address)
    ?? addressFromOrderName(valueFor(source, ["order_name", "orderName"]));
  if (!street) throw new TonomoParseError("missing required street address");
  const parsedServices: Pick<TonomoOrder, "services" | "unrecognisedServices"> = { services: [], unrecognisedServices: [] };
  for (const field of ["services_a_la_cart", "services", "items", "line_items"]) {
    const parsed = parseServices(source[field]);
    parsedServices.services.push(...parsed.services);
    parsedServices.unrecognisedServices.push(...parsed.unrecognisedServices);
  }
  if (source.videoProject === true) appendService(parsedServices, "Video", null);
  parseDeliverableLinks(source.deliverablesLinks, parsedServices);
  const firstAgent = Array.isArray(source.listingAgents) ? record(source.listingAgents[0]) : null;
  const bookingFlow = record(source.bookingFlow);
  const photographerEmails = Array.isArray(source.photographers)
    ? [...new Set(source.photographers.flatMap((photographer) => {
      const email = optionalString(record(photographer)?.email);
      return email ? [email.toLowerCase()] : [];
    }))]
    : [];

  return {
    orderId,
    orderNo: optionalString(valueFor(source, ["order_no", "orderNo", "reference"])),
    street,
    suburb: optionalString(propertyAddress?.city) ?? optionalString(source.suburb),
    postcode: optionalString(propertyAddress?.zipcode) ?? optionalString(source.postcode),
    agentName: optionalString(firstAgent?.displayName) ?? optionalString(valueFor(source, ["agent_name", "agentName"])) ?? optionalString(source.client_full_name),
    agentEmail: optionalString(firstAgent?.email) ?? optionalString(valueFor(source, ["agent_email", "agentEmail"])) ?? optionalString(source.email),
    agentPhone: optionalString(firstAgent?.phone) ?? optionalString(valueFor(source, ["agent_phone", "agentPhone"])),
    agencyName: optionalString(firstAgent?.brokerage) ?? optionalString(valueFor(source, ["agency_name", "agencyName", "agency"])) ?? optionalString(bookingFlow?.name),
    shootDate: shootDateFrom(source, propertyAddress),
    timeWindow: optionalString(valueFor(source, ["time_window", "timeWindow", "scheduled_time"])),
    invoiceAmount: optionalNumberTriState(source, ["invoice_amount", "invoiceAmount", "amount"]),
    paymentStatus: optionalStringTriState(source, ["payment_status", "paymentStatus"]),
    notes: notesFrom(source) ?? optionalString(source.notes),
    rawFolderLink: optionalString(source.rawFolderLink),
    rawFolderPath: optionalString(source.rawFolderPath),
    photographerEmails,
    ...parsedServices,
  };
}
