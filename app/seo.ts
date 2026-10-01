import type { Plugin, HtmlTagDescriptor } from 'vite';

/** Use the final public URL, never a per-build preview hostname. */
export function seoPlugin(siteUrl?: string): Plugin {
  let base: URL | undefined;
  if (siteUrl?.trim()) {
    base = new URL(siteUrl.trim());
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error('SITE_URL must be a public HTTP(S) URL without credentials, query or fragment.');
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
  }
  return {
    name: 'tsunami-seo',
    transformIndexHtml() {
      if (!base) return [];
      const image = new URL('og-image.png', base).href;
      const tags: HtmlTagDescriptor[] = [
        { tag: 'link', attrs: { rel: 'canonical', href: base.href } },
        { tag: 'meta', attrs: { property: 'og:url', content: base.href } },
        { tag: 'meta', attrs: { property: 'og:image', content: image } },
        { tag: 'meta', attrs: { property: 'og:image:type', content: 'image/png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'Tsunami Play: interactive tsunami simulation on a 3D globe.' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: image } },
        { tag: 'meta', attrs: { name: 'twitter:image:alt', content: 'Tsunami Play: interactive tsunami simulation on a 3D globe.' } },
      ];
      return tags;
    },
    generateBundle() {
      let robots = 'User-agent: *\nAllow: /\n';
      if (base) {
        const escaped = base.href.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
        this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escaped}</loc></url></urlset>\n` });
        robots += `Sitemap: ${new URL('sitemap.xml', base).href}\n`;
      } else {
        this.warn('Set SITE_URL to the final public URL to generate canonical, social image URLs and sitemap.xml.');
      }
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots });
    },
  };
}
