// tests/util/markdown.test.ts
import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../../src/util/markdown.js';

describe('markdownToHtml', () => {
  it('converts bold, italic, and inline code', () => {
    expect(markdownToHtml('**bold** and *italic* and `code`')).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>',
    );
  });

  it('converts an http/https link but escapes the surrounding text', () => {
    expect(markdownToHtml('see [docs](https://x.io)')).toBe('<p>see <a href="https://x.io">docs</a></p>');
  });

  it('does not linkify a javascript: URI', () => {
    expect(markdownToHtml('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>');
  });

  it('HTML-escapes raw angle brackets to neutralize injected markup', () => {
    expect(markdownToHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('converts an unordered list and a heading', () => {
    expect(markdownToHtml('# Title\n- one\n- two')).toBe('<h1>Title</h1>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
  });

  it('does not let a quote in a link URL break out of the href attribute (XSS)', () => {
    const html = markdownToHtml('[click](https://evil.com"onmouseover="alert(1))');
    // The raw " must be escaped; no event-handler attribute may be injected.
    expect(html).not.toContain('onmouseover="');
    expect(html).not.toContain('.com"');
    expect(html).toContain('&quot;');
  });

  it('escapes bare quotes in ordinary text', () => {
    expect(markdownToHtml(`he said "hi" and it's fine`)).toBe('<p>he said &quot;hi&quot; and it&#39;s fine</p>');
  });

  it('handles single emphasis nested inside bold without leaking literal asterisks', () => {
    expect(markdownToHtml('**a *b* c**')).toBe('<p><strong>a <em>b</em> c</strong></p>');
  });
});
