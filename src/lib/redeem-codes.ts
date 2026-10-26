import { randomBytes } from "node:crypto";
import {
  changeTokenFile,
  KeyChangeError,
  parseChanges,
  readTokenFile,
  type Account,
  type Period,
  type TokenFile,
} from "./api-tokens";

// Redeem codes: what the owner sells or gives away instead of activating
// accounts by hand. Their holder types one on /account. A plan code
// activates the account with a plan, or replaces its plan and renews it; a
// top-up code adds tokens, requests or days to an active plan. Kept with the
// accounts in tokens.json (so redeeming one and changing the account are one
// save), in plain text so the owner can copy them again later.

const DAY_MS = 86_400_000;
// No I, O, 0 or 1: nothing to misread. Twelve of them are 60 random bits.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_BATCH = 500;

export type CodePlan = {
  period: Period;
  tokens: number | null; // null: no limit
  requests: number | null;
  perMinute: number | null;
  providers: string[] | null; // null: every provider
  agentTools: boolean;
  maxKeys: number;
  // How long it lasts, from redeeming (or from the end of the plan it
  // renews); null: it doesn't end.
  days: number | null;
};

export type Redemption = { userId: string; email: string; at: string };

// What a code (or a pack in the shop, lib/shop.ts) gives an account.
export type Grant = {
  kind: "plan" | "topup";
  plan: CodePlan | null; // "plan"
  addTokens: number | null; // "topup"
  addRequests: number | null;
  addDays: number | null;
};

export type RedeemCode = Grant & {
  id: string;
  code: string; // as shown: "K7QM-2XHD-9WPB", or the owner's own text
  maxUses: number; // by different accounts; each can use a code once
  redemptions: Redemption[];
  expiresAt: string | null; // the code's own: after it, it can't be used
  disabled: boolean;
  note: string;
  createdAt: string;
  batch: string; // codes made together share one
};

// A code that can't be made, changed or used, with why (an HTTP 400). `guess`:
// no such code, which counts toward the redeemer's lockout.
export class RedeemError extends Error {
  constructor(
    message: string,
    readonly guess = false
  ) {
    super(message);
  }
}

// What's compared: letters and digits only, upper-case, so "k7qm 2xhd-9wpb"
// is K7QM-2XHD-9WPB.
export function codeKey(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function newCode(): string {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

const n = (x: number) => x.toLocaleString("en");

export function describePlan(p: CodePlan): string {
  const per = p.period === "total" ? "in total" : `a ${p.period}`;
  const amounts = [p.tokens !== null ? `${n(p.tokens)} tokens` : null, p.requests !== null ? `${n(p.requests)} requests` : null]
    .filter(Boolean)
    .join(" and ");
  return [
    amounts ? `${amounts} ${per}` : "no limit",
    p.perMinute !== null ? `up to ${n(p.perMinute)} requests a minute` : null,
    p.days !== null ? `for ${n(p.days)} days` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

// What a code or pack gives, in a few words.
export function describeCode(c: Grant): string {
  if (c.kind === "plan" && c.plan) return `Plan: ${describePlan(c.plan)}`;
  const parts = [
    c.addTokens ? `${n(c.addTokens)} tokens` : null,
    c.addRequests ? `${n(c.addRequests)} requests` : null,
    c.addDays ? `${n(c.addDays)} days` : null,
  ].filter(Boolean);
  return `Top-up: ${parts.join(", ") || "nothing"}`;
}

export type CodeStatus = "unused" | "partly used" | "used" | "expired" | "disabled";

export function statusOfCode(c: RedeemCode, now = Date.now()): CodeStatus {
  if (c.disabled) return "disabled";
  if (c.redemptions.length >= c.maxUses) return "used";
  if (c.expiresAt && Date.parse(c.expiresAt) <= now) return "expired";
  return c.redemptions.length ? "partly used" : "unused";
}

export function summarizeCode(c: RedeemCode, now = Date.now()) {
  return { ...c, status: statusOfCode(c, now), gives: describeCode(c) };
}

// ---------------------------------------------------------------------------
// The owner's side
// ---------------------------------------------------------------------------

export type NewCodes = Grant & {
  maxUses: number;
  count: number;
  code: string | null; // the owner's own text, for a single code
  expiresAt: string | null;
  note: string;
};

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new RedeemError(`\`${field}\` must be a whole number from ${n(min)} to ${n(max)}`);
  }
  return value;
}

// What a request body says to give, checked: a plan (`limits`, `providers`,
// `agentTools`, `maxKeys`, `days`) or a top-up (`addTokens`, `addRequests`,
// `addDays`), with `expiresAt` and `note`, which callers use for their own
// things. For codes and for the shop's packs (lib/shop.ts).
export function parseGrant(
  body: unknown,
  knownProviders: readonly string[]
): Grant & { expiresAt: string | null; note: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RedeemError("Send a JSON object");
  const b = body as Record<string, unknown>;
  if (b.kind !== "plan" && b.kind !== "topup") throw new RedeemError("`kind` must be plan or topup");
  let changes;
  try {
    // The plan's fields are checked like an account's.
    changes = parseChanges(
      {
        ...(b.limits !== undefined ? { limits: b.limits } : {}),
        ...(b.providers !== undefined ? { providers: b.providers } : {}),
        ...(b.agentTools !== undefined ? { agentTools: b.agentTools } : {}),
        ...(b.maxKeys !== undefined ? { maxKeys: b.maxKeys } : {}),
        ...(b.expiresAt !== undefined ? { expiresAt: b.expiresAt } : {}),
        ...(b.note !== undefined ? { note: b.note } : {}),
      },
      knownProviders
    );
  } catch (err) {
    if (err instanceof KeyChangeError) throw new RedeemError(err.message);
    throw err;
  }
  const optional = (field: string, max: number) =>
    b[field] === undefined || b[field] === null || b[field] === 0 ? null : whole(b[field], field, 1, max);

  const result: Grant & { expiresAt: string | null; note: string } = {
    kind: b.kind,
    plan: null,
    addTokens: null,
    addRequests: null,
    addDays: null,
    expiresAt: changes.expiresAt ?? null,
    note: changes.note ?? "",
  };
  if (b.kind === "plan") {
    const limits = changes.limits ?? {};
    result.plan = {
      period: limits.period ?? "month",
      tokens: limits.tokens ?? null,
      requests: limits.requests ?? null,
      perMinute: limits.perMinute ?? null,
      providers: changes.providers ?? null,
      agentTools: changes.agentTools ?? false,
      maxKeys: changes.maxKeys ?? 5,
      days: optional("days", 3650),
    };
  } else {
    result.addTokens = optional("addTokens", 1e15);
    result.addRequests = optional("addRequests", 1e15);
    result.addDays = optional("addDays", 3650);
    if (!result.addTokens && !result.addRequests && !result.addDays) {
      throw new RedeemError("A top-up needs tokens, requests or days to add");
    }
  }
  return result;
}

// A request to make codes, checked: POST /api/codes.
export function parseNewCodes(body: unknown, knownProviders: readonly string[]): NewCodes {
  const grant = parseGrant(body, knownProviders);
  const b = body as Record<string, unknown>;
  const count = b.count === undefined ? 1 : whole(b.count, "count", 1, MAX_BATCH);
  const own = typeof b.code === "string" && b.code.trim() ? b.code.trim().toUpperCase().slice(0, 40) : null;
  if (own && count > 1) throw new RedeemError("Your own code text is for a single code: leave `count` at 1");
  if (own && codeKey(own).length < 4) throw new RedeemError("A code needs at least 4 letters or digits");
  return {
    ...grant,
    maxUses: b.maxUses === undefined ? 1 : whole(b.maxUses, "maxUses", 1, 100_000),
    count,
    code: own,
  };
}

// Makes the codes in `file`, unsaved: for changeTokenFile.
function createCodesIn(file: TokenFile, spec: NewCodes): RedeemCode[] {
  const taken = new Set(file.codes.map((c) => codeKey(c.code)));
  if (spec.code && taken.has(codeKey(spec.code))) throw new RedeemError(`There's already a code ${spec.code}`);
  const batch = randomBytes(6).toString("hex");
  const createdAt = new Date().toISOString();
  const made: RedeemCode[] = [];
  for (let i = 0; i < spec.count; i++) {
    let code = spec.code ?? newCode();
    while (taken.has(codeKey(code))) code = newCode();
    taken.add(codeKey(code));
    made.push({
      id: randomBytes(8).toString("hex"),
      code,
      kind: spec.kind,
      plan: spec.plan ? { ...spec.plan } : null,
      addTokens: spec.addTokens,
      addRequests: spec.addRequests,
      addDays: spec.addDays,
      maxUses: spec.maxUses,
      redemptions: [],
      expiresAt: spec.expiresAt,
      disabled: false,
      note: spec.note,
      createdAt,
      batch,
    });
  }
  file.codes.push(...made);
  return made;
}

export async function createCodes(spec: NewCodes): Promise<RedeemCode[]> {
  return changeTokenFile((file) => createCodesIn(file, spec));
}

// One single-use code for `grant`, made in `file` unsaved: what a sale in the
// shop gives (lib/shop.ts).
export function issueCodeIn(file: TokenFile, grant: Grant, note: string): RedeemCode {
  return createCodesIn(file, { ...grant, maxUses: 1, count: 1, code: null, expiresAt: null, note })[0];
}

// Newest first.
export async function listCodes(): Promise<RedeemCode[]> {
  return [...(await readTokenFile()).codes].reverse();
}

// Turn a code off or on, or change its note. Null when there's no such code.
export async function updateCode(id: string, changes: { disabled?: boolean; note?: string }): Promise<RedeemCode | null> {
  return changeTokenFile((file) => {
    const code = file.codes.find((c) => c.id === id);
    if (!code) return null;
    if (changes.disabled !== undefined) code.disabled = changes.disabled;
    if (changes.note !== undefined) code.note = changes.note.trim().slice(0, 1000);
    return code;
  });
}

// Deleting a used code leaves what it gave in place.
export async function deleteCode(id: string): Promise<boolean> {
  return changeTokenFile((file) => {
    const before = file.codes.length;
    file.codes = file.codes.filter((c) => c.id !== id);
    return file.codes.length < before;
  });
}

// ---------------------------------------------------------------------------
// Redeeming
// ---------------------------------------------------------------------------

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

// Whether `next` opens no provider that `current` didn't (null: all of them).
export function sameOrFewer(next: string[] | null, current: string[] | null): boolean {
  if (current === null) return true;
  return next !== null && next.every((p) => current.includes(p));
}

// Gives `account` what the code gives, and says what that was. The account
// must exist (ensureAccount) first.
function apply(code: RedeemCode, account: Account, now: number): string {
  if (code.kind === "plan" && code.plan) {
    const p = code.plan;
    const used = account.total;
    const current = Boolean(account.activatedAt) && !(account.expiresAt && Date.parse(account.expiresAt) <= now);
    // Renewing a plan that hasn't ended counts its days from that end.
    const start = current && account.expiresAt ? Date.parse(account.expiresAt) : now;
    // A prepaid amount ("in total") counts all the account's use, so it's
    // set to what's been used plus what the code gives; on a prepaid plan
    // that hasn't ended, what's left of it is kept too, as long as the new
    // plan opens no provider the old one didn't (or tokens bought cheap for
    // one provider could be spent on a dearer one).
    const carry =
      current && p.period === "total" && account.limits.period === "total" && sameOrFewer(p.providers, account.providers);
    const prepaid = (given: number, limit: number | null, usedSoFar: number) =>
      (carry && limit !== null ? Math.max(limit, usedSoFar) : usedSoFar) + given;
    account.limits = {
      period: p.period,
      tokens: p.tokens === null ? null : p.period === "total" ? prepaid(p.tokens, account.limits.tokens, used.tokens) : p.tokens,
      requests:
        p.requests === null
          ? null
          : p.period === "total"
            ? prepaid(p.requests, account.limits.requests, used.requests - used.errors)
            : p.requests,
      perMinute: p.perMinute,
    };
    account.providers = p.providers ? [...p.providers] : null;
    account.agentTools = p.agentTools;
    account.maxKeys = p.maxKeys;
    // Adding to what's left never shortens it: a prepaid plan with no end keeps none.
    const keepsNoEnd = carry && account.expiresAt === null;
    account.expiresAt = p.days === null || keepsNoEnd ? null : new Date(start + p.days * DAY_MS).toISOString();
    account.activatedAt ??= new Date(now).toISOString();
    const until = account.expiresAt ? `, until ${dateFormat.format(new Date(account.expiresAt))}` : "";
    if (carry && p.tokens !== null && account.limits.tokens !== null) {
      return `Added ${n(p.tokens)} tokens: you have ${n(account.limits.tokens - used.tokens)} left${until}.`;
    }
    return `Your plan is now ${describePlan(p)}${until}.`;
  }

  if (!account.activatedAt) {
    throw new RedeemError("This code adds to an active plan, and your account isn't active yet. Redeem a plan code first.");
  }
  const added: string[] = [];
  if (code.addTokens && account.limits.tokens !== null) {
    account.limits.tokens += code.addTokens;
    added.push(`${n(code.addTokens)} tokens`);
  }
  if (code.addRequests && account.limits.requests !== null) {
    account.limits.requests += code.addRequests;
    added.push(`${n(code.addRequests)} requests`);
  }
  if (code.addDays && account.expiresAt) {
    account.expiresAt = new Date(Math.max(Date.parse(account.expiresAt), now) + code.addDays * DAY_MS).toISOString();
    added.push(`${n(code.addDays)} days`);
  }
  if (!added.length) {
    throw new RedeemError("This code wouldn't add anything: your plan has no limit or end date for it to add to.");
  }
  return `Added ${added.join(" and ")} to your plan.`;
}

// Redeems `text` for the signed-in user. Throws a RedeemError when it can't.
export async function redeem(user: { id: string; email: string }, text: string): Promise<string> {
  return changeTokenFile((file) => redeemIn(file, user, text));
}

// The same in `file`, unsaved: for changeTokenFile. Changes nothing when it throws.
export function redeemIn(file: TokenFile, user: { id: string; email: string }, text: string): string {
  const wanted = codeKey(text);
  if (!wanted) throw new RedeemError("Type the code.");
  const now = Date.now();
  const code = file.codes.find((c) => codeKey(c.code) === wanted);
  if (!code) throw new RedeemError("There's no such code. Check it and try again.", true);
  if (code.disabled) throw new RedeemError("That code has been turned off.");
  if (code.expiresAt && Date.parse(code.expiresAt) <= now) {
    throw new RedeemError(`That code expired on ${dateFormat.format(new Date(code.expiresAt))}.`);
  }
  if (code.redemptions.some((r) => r.userId === user.id)) throw new RedeemError("You've already used this code.");
  if (code.redemptions.length >= code.maxUses) throw new RedeemError("That code has already been used.");
  const account = file.accounts.find((a) => a.userId === user.id);
  if (!account) throw new RedeemError("Your account isn't ready yet: reload the page and try again.");
  if (account.disabled) throw new RedeemError("Your account is turned off, so it can't take codes.");

  // Changed on a copy, so a code that can't be used leaves it as it was.
  const draft = structuredClone(account);
  const applied = apply(code, draft, now);
  Object.assign(account, draft);
  code.redemptions.push({ userId: user.id, email: user.email, at: new Date(now).toISOString() });
  return applied;
}
