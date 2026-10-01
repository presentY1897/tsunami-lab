import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { seoPlugin } from '../../app/seo';

async function assets(siteUrl?: string) {
  const result = await build({
    configFile: false, root: 'app', logLevel: 'silent', plugins: [seoPlugin(siteUrl)],
    build: { write: false, copyPublicDir: false },
  });
  if (!('output' in result)) throw new Error('Expected a single build output');
  return Object.fromEntries(result.output.flatMap(file => file.type === 'asset' ? [[file.fileName, String(file.source)]] : []));
}

describe('static SEO output', () => {
  it('publishes canonical, social URLs and a single scenario-free sitemap entry', async () => {
    const output = await assets('https://tsunami.example/play');
    const html = output['index.html'];
    expect(html).toContain('rel="canonical" href="https://tsunami.example/play/"');
    expect(html).toContain('property="og:image" content="https://tsunami.example/play/og-image.png"');
    expect(html).toContain('name="twitter:image" content="https://tsunami.example/play/og-image.png"');
    expect(html).toContain('Tsunami Play — Interactive 3D Tsunami Simulator</title>');
    expect(html).toContain('Explore tsunamis on a 3D globe');
    expect(output['sitemap.xml']).toContain('<loc>https://tsunami.example/play/</loc>');
    expect(output['robots.txt']).toContain('Sitemap: https://tsunami.example/play/sitemap.xml');
  });
  it('does not invent a public URL when deployment has not been configured', async () => {
    const output = await assets();
    expect(output['index.html']).not.toContain('rel="canonical"');
    expect(output['index.html']).not.toContain('property="og:image"');
    expect(output['sitemap.xml']).toBeUndefined();
    expect(output['robots.txt']).toBe('User-agent: *\nAllow: /\n');
  });
  it('rejects scenario URLs and non-web protocols as the site URL', () => {
    for (const value of ['https://tsunami.example/?lang=ko', 'https://tsunami.example/#scenario', 'ftp://tsunami.example', 'https://user:secret@tsunami.example']) {
      expect(() => seoPlugin(value)).toThrow();
    }
  });
});
