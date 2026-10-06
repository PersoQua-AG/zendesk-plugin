// tests/tools/guide-raw-html-safety.test.ts
// #60: a markdown:false body is checked before any request. The four Guide write paths all route
// through renderBody, so the matrix below is four tools × four active-content payloads: none may
// reach client.request, and the refusal must name the construct. The happy path pins that the rich
// content the raw path advertises (tables, images) still arrives byte-identically.
import { describe, it, expect, vi } from 'vitest';
import {
  createArticle,
  updateArticle,
  createArticleTranslation,
  updateArticleTranslation,
} from '../../src/tools/guide/articles.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'h', path: '/x' }) } as unknown as ResponseCache;
}

// async so a synchronous refusal surfaces as a rejection — the registered MCP handler is async too,
// so a throw from renderBody reaches the server as a rejected promise exactly like this.
type Call = (client: ZendeskHttpClient, body: string) => Promise<unknown>;

const TOOLS: [string, Call][] = [
  ['zendesk_create_article', async (client, body) =>
    createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body }, markdown: false })],
  ['zendesk_update_article', async (client, body) =>
    updateArticle(client, cacheStub(), { articleId: 50, fields: { body }, markdown: false })],
  ['zendesk_create_article_translation', async (client, body) =>
    createArticleTranslation(client, cacheStub(), { articleId: 5, fields: { locale: 'de', title: 'T', body }, markdown: false })],
  ['zendesk_update_article_translation', async (client, body) =>
    updateArticleTranslation(client, cacheStub(), { articleId: 5, locale: 'de', fields: { body }, markdown: false })],
];

// The construct each payload must be named by, as a case-insensitive fragment of the refusal.
const PAYLOADS: [string, RegExp][] = [
  ['<script>alert(1)</script>', /<script>/i],
  ['<img src=x onerror=alert(1)>', /onerror/i],
  ['<a href="javascript:alert(1)">x</a>', /javascript:alert\(1\)/i],
  ['<iframe src="https://evil.test"></iframe>', /<iframe>/i],
];

describe('markdown:false bodies are checked before the request', () => {
  for (const [tool, call] of TOOLS) {
    for (const [payload, named] of PAYLOADS) {
      it(`${tool} refuses ${payload} and names the construct`, async () => {
        const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
        await expect(call(client, payload)).rejects.toThrow(named);
        expect(client.request).not.toHaveBeenCalled();
      });
    }
  }
});

describe('markdown:false still carries the advertised rich content', () => {
  const RICH = '<table><tr><td>a</td></tr></table><img src="https://x.test/a.png">';

  it('sends a table plus an https image byte-identically', async () => {
    const client = { request: vi.fn().mockResolvedValue({ article: { id: 60 } }) } as unknown as ZendeskHttpClient;
    await createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body: RICH }, markdown: false });
    const sent = JSON.parse((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sent.article.body).toBe(RICH);
  });

  it('accepts nested lists and relative links', async () => {
    const body = '<ul><li>a<ol><li><a href="/hc/en-us/articles/1">x</a></li></ol></li></ul>';
    const client = { request: vi.fn().mockResolvedValue({ article: { id: 61 } }) } as unknown as ZendeskHttpClient;
    await updateArticle(client, cacheStub(), { articleId: 61, fields: { body }, markdown: false });
    expect(JSON.parse((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body).article.body).toBe(body);
  });
});

// The classic evasions a regex check waves through. Fail-closed: each must be refused.
describe('evasions are refused', () => {
  it.each([
    ['slash as attribute separator', '<img/src=x onerror=alert(1)>'],
    ['entity-encoded scheme', '<a href="java&#115;cript:alert(1)">x</a>'],
    ['double-encoded colon', '<a href="javascript&amp;#58;alert(1)">x</a>'],
    ['uppercase tag and handler', '<IMG SRC=x ONERROR=alert(1)>'],
    ['newline inside the attribute name', '<img src=x on\nerror=alert(1)>'],
    ['tab inside the attribute name', '<img src=x on\terror=alert(1)>'],
    ['data: URL', '<img src="data:text/html;base64,PHNjcmlwdD4=">'],
    ['svg with onload', '<svg onload=alert(1)>'],
    ['unterminated tag', '<script src=//evil.test'],
    ['unknown element', '<object data="https://evil.test"></object>'],
    ['style attribute', '<div style="background:url(javascript:alert(1))">x</div>'],
    ['vbscript scheme', '<a href="vbscript:msgbox(1)">x</a>'],
  ])('refuses %s', async (_label, body) => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(
      (async () => createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body }, markdown: false }))(),
    ).rejects.toThrow(/Refusing to send raw HTML/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});

// A `>` inside a quoted attribute value ends the tag for this check but not for an HTML tokenizer,
// which stays in the attribute-value state. Everything after that `>` up to the next `<` is skipped
// as text, so any attribute parked there is never looked at. The browser still sees it. These pin
// the three shapes that reach client.request today (#60 follow-up).
describe('a > inside a quoted attribute value does not end the tag for a browser', () => {
  it.each([
    ['onerror parked after the split', '<img src="https://x.test/a.png" alt="a>b" onerror=alert(1)>', /onerror/i],
    ['javascript: href parked after the split', '<a title="x>" href="javascript:alert(1)">y</a>', /javascript:/i],
    ['onclick parked after the split', '<img alt="z>" src=x onclick="alert(1)">', /onclick/i],
  ])('refuses %s', async (_label, body, named) => {
    const client = { request: vi.fn().mockResolvedValue({ article: { id: 62 } }) } as unknown as ZendeskHttpClient;
    await expect(
      (async () => createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body }, markdown: false }))(),
    ).rejects.toThrow(named);
    expect(client.request).not.toHaveBeenCalled();
  });
});

// The twelve evasions above all attack classes the grammar already recognises. These attack the
// SCANNER'S OWN STATE BOUNDARIES — quote state, tag boundary, cursor end — which is where the
// `>`-inside-a-value defect actually lived. Each one parks something active where a boundary bug
// would skip it.
describe('scanner state boundaries are fail-closed', () => {
  it.each([
    ['nested quotes, handler after', `<a title="he said 'hi'" onclick="alert(1)">x</a>`],
    ['single-quoted value containing >', `<img alt='a>b' onerror=alert(1)>`],
    ['backtick as a quote (IE legacy)', '<img src=x onerror=`alert(1)`>'],
    ['value left unclosed to the end of the body', '<img alt="a>b onerror=alert(1)>'],
    ['slash before > with a handler', '<img src="a>b" onerror=alert(1)/>'],
    ['several > inside one value', '<img alt="a>b>c>d" onerror=alert(1)>'],
    ['quote inside an unquoted value', '<img src=x"y onerror=alert(1)>'],
    ['> in value then a javascript: href', `<a title="x>" href='javascript:alert(1)'>y</a>`],
    ['mixed quote types straddling the >', `<img alt="a'>b" onerror=alert(1)>`],
    ['> as the whole value, then a javascript: src', '<img alt=">" src="javascript:alert(1)">'],
    ['handler on the next line after a > value', '<img alt="a>b"\n onerror=alert(1)>'],
    ['empty attribute name after a > value', '<img alt="a>b" ="x">'],
    ['script element hidden behind a > value', '<img alt="a>b"><script>alert(1)</script>'],
    ['unterminated plain tag', '<img src=x'],
    ['comment', '<!-- x -->'],
    ['bare data- prefix with no name', '<div data->x</div>'],
  ])('refuses %s', async (_label, body) => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(
      (async () => createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body }, markdown: false }))(),
    ).rejects.toThrow(/Refusing to send raw HTML/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});

// The allowlist has to carry what the Zendesk Guide editor itself emits, or a read-modify-write of
// an existing article is refused and the author has no way through (markdownToHtml cannot do tables).
describe('markup the Guide editor produces is accepted', () => {
  it.each([
    ['target with rel', '<a href="https://x.test" target="_blank" rel="noopener">x</a>'],
    ['table border/cellpadding', '<table border="1" cellpadding="4"><tr><td>a</td></tr></table>'],
    ['details/summary', '<details><summary>More</summary><p>x</p></details>'],
    ['section', '<section><p>x</p></section>'],
    ['data-* attribute', '<div data-id="1">x</div>'],
    ['role and aria-*', '<table role="presentation" aria-label="x"><tr><td>a</td></tr></table>'],
    ['ol start', '<ol start="3"><li>a</li></ol>'],
    ['a literal < in text', '<p>use 5 < 6 here</p>'],
    ['trailing space before >', '<p>x</p><img src="https://x.test/a.png" >'],
    ['self-closing img', '<p>x</p><img src="https://x.test/a.png"/>'],
  ])('sends %s byte-identically', async (_label, body) => {
    const client = { request: vi.fn().mockResolvedValue({ article: { id: 63 } }) } as unknown as ZendeskHttpClient;
    await createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body }, markdown: false });
    expect(JSON.parse((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body).article.body).toBe(body);
  });
});

// The refusal hinges themselves: a disallowed close tag, a tag name the grammar cannot read, and
// both ends of the contiguous-attribute check. These are the branches a security gate must not
// leave untested.
describe('each refusal hinge is reachable and named', () => {
  it.each([
    ['a disallowed close tag', '<p>x</script>', /<script> element/i],
    ['a processing instruction', '<?php echo 1 ?>', /not a tag this check can read/i],
    ['an attribute the grammar cannot start on', '<img ="x">', /cannot read/i],
    ['a disallowed attribute', '<div style="x">y</div>', /attribute "style"/i],
    ['an unterminated tag', '<img src=x', /unterminated tag/i],
  ])('refuses %s with a named reason', async (_label, body, named) => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(
      (async () => createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body }, markdown: false }))(),
    ).rejects.toThrow(named);
    expect(client.request).not.toHaveBeenCalled();
  });
});

// Remaining decoder/scanner branches, each with the behaviour it decides. A security gate should
// not carry untested branches, and these are the last of them.
describe('decoder and scanner edge branches', () => {
  it.each([
    ['a valueless href', '<p>x</p><a href>y</a>'],
    ['a named entity outside the scheme set', '<a href="https://x.test/&nbsp;a">y</a>'],
    ['an out-of-range numeric entity', '<a href="https://x.test/&#xFFFFFFFF;">y</a>'],
    ['a trailing < at the very end', '<p>x</p><'],
  ])('accepts %s', async (_label, body) => {
    const client = { request: vi.fn().mockResolvedValue({ article: { id: 64 } }) } as unknown as ZendeskHttpClient;
    await createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body }, markdown: false });
    expect(JSON.parse((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body).article.body).toBe(body);
  });

  it('refuses leftover the attribute grammar cannot consume', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(
      (async () => createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body: '<img src=x =>' }, markdown: false }))(),
    ).rejects.toThrow(/cannot read/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});
