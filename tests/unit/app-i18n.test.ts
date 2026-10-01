import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { formatClock, formatNumber, messages, resolveLocale, setLocale, t, th } from '../../app/src/i18n';

afterEach(() => setLocale('en'));
describe('locale contract', () => {
  it('every language supplies the same keys and interpolation parameters', () => {
    const keys = Object.keys(messages.ko) as (keyof typeof messages.ko)[];
    expect(Object.keys(messages.en).sort()).toEqual([...keys].sort());
    const tokens = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort();
    for (const k of keys) {
      expect(messages.en[k].trim()).not.toBe('');
      expect(tokens(messages.en[k]), k).toEqual(tokens(messages.ko[k]));
    }
    const html = readFileSync('app/index.html', 'utf8');
    for (const [, key] of html.matchAll(/data-i18n(?:-aria-label|-content)?="([^"]+)"/g)) expect(keys).toContain(key);
  });
  it('uses URL, saved preference, then English by default', () => {
    expect(resolveLocale('en', 'ko')).toBe('en');
    expect(resolveLocale('ko-KR', 'en')).toBe('ko');
    expect(resolveLocale('invalid', 'en-US')).toBe('en');
    expect(resolveLocale(null, 'ko')).toBe('ko');
    expect(resolveLocale(null, null)).toBe('en');
    expect(resolveLocale('invalid', 'invalid')).toBe('en');
  });
  it('formats elapsed time and numbers without leaking translation tokens', () => {
    setLocale('ko');
    expect(formatClock(3599)).toBe('1시간 0분');
    expect(formatClock(0)).toBe('0분');
    setLocale('en');
    expect(formatClock(4320)).toBe('1 h 12 min');
    expect(formatNumber(1234.56, 1)).toBe('1,234.6');
    expect(t('sim.seeking', { time: formatClock(600) })).toBe('Calculating to 10 min');
  });
  it('keeps catalog markup but escapes interpolated data', () => {
    setLocale('en');
    const result = th('location.summary', { label: '<img onerror="alert(1)">', height: 42, location: 'A & B', note: '' });
    expect(result).toContain('<b>42 m</b>');
    expect(result).not.toContain('<img');
    expect(result).toContain('A &amp; B');
  });
});
