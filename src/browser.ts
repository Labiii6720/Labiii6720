import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { config } from "./config.js";

/** Nur das, was Jarvis von einer Seite braucht – so lässt sich der Browser im Test ersetzen. */
export interface PageLike {
  goto(url: string, opts?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  evaluate<T>(fn: () => T): Promise<T>;
  getByText(text: string, opts?: { exact?: boolean }): { first(): { click(opts?: { timeout?: number }): Promise<void> } };
  getByRole(role: "link" | "button", opts: { name: string; exact?: boolean }): { first(): { click(opts?: { timeout?: number }): Promise<void> } };
  getByLabel(text: string): { first(): { fill(v: string): Promise<void>; press(k: string): Promise<void>; count(): Promise<number> } };
  getByPlaceholder(text: string): { first(): { fill(v: string): Promise<void>; press(k: string): Promise<void>; count(): Promise<number> } };
  locator(sel: string): { first(): { fill(v: string): Promise<void>; press(k: string): Promise<void>; count(): Promise<number> } };
  screenshot(opts: { type: "jpeg"; quality: number }): Promise<Buffer>;
  goBack(opts?: { timeout?: number }): Promise<unknown>;
  waitForLoadState(state: "domcontentloaded", opts?: { timeout?: number }): Promise<void>;
}

type Launcher = () => Promise<PageLike>;

const CANDIDATES = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/snap/bin/chromium"];

export function browserPath(): string | undefined {
  if (config.browserPath) return existsSync(config.browserPath) ? config.browserPath : undefined;
  return CANDIDATES.find((p) => existsSync(p));
}

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: PageLike | undefined;

/** Echter Chromium: frisches Profil ohne Logins oder Cookies, Downloads aus. */
const realLauncher: Launcher = async () => {
  const path = browserPath();
  if (!path) throw new Error("Kein Browser gefunden. Chromium installieren (apt install chromium) oder BROWSER_PATH setzen.");
  browser ??= await chromium.launch({ executablePath: path, headless: true });
  context ??= await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "de-CH",
    acceptDownloads: false,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Jarvis/0.4",
  });
  const p = await context.newPage();
  p.setDefaultTimeout(15_000);
  return p as unknown as PageLike;
};

let launcher: Launcher = realLauncher;

/** Nur für Tests: Browser durch eine Attrappe ersetzen. */
export function setLauncher(l: Launcher): void {
  launcher = l;
  page = undefined;
}

async function current(): Promise<PageLike> {
  page ??= await launcher();
  return page;
}

export const hasBrowser = () => launcher !== realLauncher || Boolean(browserPath());

/** Text und Links der aktuellen Seite, gekürzt. */
export async function describePage(p: PageLike, maxChars = 6000): Promise<string> {
  const title = await p.title().catch(() => "");
  const { text, links } = await p.evaluate(() => {
    const body = document.body?.innerText ?? "";
    const seen = new Set<string>();
    const links: string[] = [];
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const el = a as HTMLAnchorElement;
      const label = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (!label || seen.has(el.href) || el.href.startsWith("javascript:")) continue;
      seen.add(el.href);
      links.push(`${label} → ${el.href}`);
      if (links.length >= 40) break;
    }
    return { text: body, links };
  });
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const body = clean.length > maxChars ? `${clean.slice(0, maxChars)}\n… [gekürzt, ${clean.length} Zeichen]` : clean;
  return `Titel: ${title}\nURL: ${p.url()}\n\n${body}\n\nLinks:\n${links.join("\n")}`;
}

export async function open(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const p = await current();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
  return describePage(p);
}

export async function read(maxChars = 12_000): Promise<string> {
  return describePage(await current(), maxChars);
}

export async function click(text: string): Promise<string> {
  const p = await current();
  try {
    await p.getByRole("link", { name: text, exact: false }).first().click({ timeout: 4000 });
  } catch {
    try {
      await p.getByRole("button", { name: text, exact: false }).first().click({ timeout: 4000 });
    } catch {
      await p.getByText(text, { exact: false }).first().click({ timeout: 4000 });
    }
  }
  await p.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
  return describePage(p);
}

export async function type(field: string, value: string, enter: boolean): Promise<string> {
  const p = await current();
  const candidates = [p.getByLabel(field).first(), p.getByPlaceholder(field).first(), p.locator(`[name="${field.replace(/"/g, "")}"]`).first(), p.locator("input[type=search], input[type=text], textarea").first()];
  for (const c of candidates) {
    if ((await c.count().catch(() => 0)) > 0) {
      await c.fill(value);
      if (enter) {
        await c.press("Enter");
        await p.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
      }
      return describePage(p, 4000);
    }
  }
  throw new Error(`Kein Eingabefeld «${field}» gefunden.`);
}

export async function screenshot(): Promise<Buffer> {
  return (await current()).screenshot({ type: "jpeg", quality: 55 });
}

export async function back(): Promise<string> {
  const p = await current();
  await p.goBack({ timeout: 10_000 });
  return describePage(p, 4000);
}

export async function closeBrowser(): Promise<void> {
  page = undefined;
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  context = undefined;
  browser = undefined;
}

// ---------- Ersatz ohne Browser: Seite laden und zu Text machen ----------

export async function fetchPageText(url: string, maxChars = 12_000): Promise<string> {
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Jarvis/0.4)", Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
  const type = res.headers.get("content-type") ?? "";
  const raw = (await res.text()).slice(0, 2_000_000);
  const text = type.includes("html") ? htmlToText(raw) : raw;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? "";
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n… [gekürzt, ${text.length} Zeichen]` : text;
  return `Titel: ${title}\nURL: ${url}\n\n${body}`;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
