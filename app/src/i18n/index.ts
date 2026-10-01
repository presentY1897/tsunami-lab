import { ko, type MessageKey } from './ko';
import { en } from './en';

export type Locale = 'ko' | 'en';
export type { MessageKey };
export class LocalizedError extends Error {
  constructor(readonly key: MessageKey) { super(key); }
}
export const messages = { ko, en };
const tags = { ko: 'ko-KR', en: 'en-US' };
let locale: Locale = 'en';
const listeners = new Set<() => void>();
const bindings = new Map<HTMLElement, Map<string, () => void>>();
const numbers = new Map<string, Intl.NumberFormat>();

export const getLocale = (): Locale => locale;
export function parseLocale(value: string | null | undefined): Locale | null {
  const language = value?.toLowerCase().split(/[-_]/)[0];
  return language === 'ko' || language === 'en' ? language : null;
}
/** URL → saved choice → English default. */
export function resolveLocale(query: string | null, saved: string | null): Locale {
  return parseLocale(query) ?? parseLocale(saved) ?? 'en';
}
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  return (messages[locale][key] ?? ko[key]).replace(/\{(\w+)\}/g, (token, name: string) => Object.hasOwn(params, name) ? String(params[name]) : token);
}
export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
/** Only catalog strings may contain markup. Interpolated values are always escaped. */
export function th(key: MessageKey, params: Record<string, string | number> = {}): string {
  return t(key, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, escapeHtml(v)])));
}
export function formatNumber(value: number, decimals = 0): string {
  const key = `${locale}:${decimals}`;
  let formatter = numbers.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(tags[locale], { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    numbers.set(key, formatter);
  }
  return formatter.format(value);
}
export function formatClock(seconds: number): string {
  const minutes = Math.round(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? t('time.hoursMinutes', { hours: formatNumber(hours), minutes: formatNumber(minutes % 60) }) : t('time.minutes', { minutes: formatNumber(minutes) });
}

function bind(target: string | HTMLElement, slot: string, update: (el: HTMLElement) => void): void {
  const el = typeof target === 'string' ? document.getElementById(target)! : target;
  const slots = bindings.get(el) ?? new Map<string, () => void>();
  slots.set(slot, () => update(el));
  bindings.set(el, slots);
  update(el);
}
/** Retain render callbacks so language changes do not recreate or reset a simulation. */
export function text(target: string | HTMLElement, render: () => string): void {
  bind(target, 'content', el => { el.textContent = render(); });
}
export function html(target: string | HTMLElement, render: () => string): void {
  bind(target, 'content', el => { el.innerHTML = render(); });
}
export function attribute(target: string | HTMLElement, name: string, render: () => string): void {
  bind(target, name, el => el.setAttribute(name, render()));
}
function applyDocument(): void {
  document.documentElement.lang = locale;
  for (const attr of ['text', 'aria-label', 'content'] as const) {
    const data = attr === 'text' ? 'data-i18n' : `data-i18n-${attr}`;
    document.querySelectorAll<HTMLElement>(`[${data}]`).forEach(el => {
      const key = el.getAttribute(data) as MessageKey;
      if (!Object.hasOwn(ko, key)) return;
      if (attr === 'text') el.textContent = t(key);
      else el.setAttribute(attr, t(key));
    });
  }
  const control = document.getElementById('language') as HTMLSelectElement | null;
  if (control) control.value = locale;
  for (const slots of bindings.values()) for (const update of slots.values()) update();
  for (const update of listeners) update();
}
export function onLocaleChange(update: () => void): void { listeners.add(update); }
export function setLocale(next: Locale): void {
  locale = next;
  if (typeof document === 'undefined') return;
  try { localStorage.setItem('locale', next); } catch { /* Private browsing may block storage. */ }
  const url = new URL(location.href);
  url.searchParams.set('lang', next);
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  applyDocument();
}
export function initI18n(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem('locale'); } catch { /* Use URL/default language. */ }
  locale = resolveLocale(new URLSearchParams(location.search).get('lang'), saved);
  applyDocument();
  document.getElementById('language')?.addEventListener('change', event => {
    const next = parseLocale((event.target as HTMLSelectElement).value);
    if (next) setLocale(next);
  });
}
