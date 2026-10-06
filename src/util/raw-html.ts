// src/util/raw-html.ts
// Dependency-free, fail-closed check for `markdown:false` bodies (#60). The raw path advertises
// rich content (tables, images, nested lists) and never promised active content, so this allows an
// explicit element/attribute set and refuses everything else BEFORE the request — a clean body is
// passed on byte-identically. Allowlist, not blocklist: an unparseable or unknown construct is
// refused rather than guessed at, which is what makes entity- and whitespace-based evasion moot.
//
// Tag boundaries follow the HTML tokenizer, not the first `>`: inside a quoted attribute value a
// `>` does not end the tag. Scanning for a bare `>` instead let an attribute parked after such a
// `>` ride along uninspected while the browser still applied it.

// Rich-content set: what markdownToHtml emits, plus tables/figures/definition lists and the
// structural elements the Zendesk Guide editor produces. None of these run script on their own.
const ALLOWED_ELEMENTS = new Set([
  'p', 'br', 'hr', 'div', 'span', 'section', 'blockquote', 'pre', 'code', 'kbd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'a', 'img', 'figure', 'figcaption', 'details', 'summary',
  'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark', 'abbr', 'time', 'cite',
]);

// `style` is absent on purpose: a style attribute can carry a URL (`background:url(...)`) and is
// not needed for the advertised content. Every `on*` handler is excluded by construction, and
// rejected explicitly below so the refusal names it as an event handler.
const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'id', 'class', 'lang', 'dir', 'role',
  'width', 'height', 'colspan', 'rowspan', 'headers', 'scope', 'span', 'align', 'rel', 'loading',
  'target', 'border', 'cellpadding', 'cellspacing', 'start', 'reversed', 'datetime', 'open',
]);

// Namespaced families that carry author metadata only: `aria-*` is consumed by assistive tech and
// `data-*` is inert unless page script reads it. Neither can execute on its own, and neither is a
// URL, so they are matched by prefix rather than enumerated.
const ALLOWED_ATTR_PREFIXES = ['aria-', 'data-'];

const URL_ATTRS = new Set(['href', 'src']);

// Not the HTML named-character list — only the handful that can smuggle a scheme separator or a
// space past the URL check (`&colon;`, `&Tab;`, `&NewLine;`) plus the ones needed to undo double
// encoding. Anything else is left as-is, which keeps a stray `&` from becoming a scheme.
const SCHEME_ENTITIES = new Map([['amp', '&'], ['colon', ':'], ['tab', '\t'], ['newline', '\n'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

// Decoded twice so a double-encoded scheme (`&amp;#58;`) resolves to the same `:` the browser sees.
function decodeEntities(s: string): string {
  const once = (t: string) => t
    .replace(/&#x([0-9a-f]+);?/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);?/g, (m, d) => safeChar(parseInt(d, 10), m))
    .replace(/&([a-z]+);?/gi, (m, n) => SCHEME_ENTITIES.get(n.toLowerCase()) ?? m);
  return once(once(s));
}

function safeChar(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

// http(s) or scheme-relative only. Everything from NUL to SPACE inclusive is stripped first: a URL
// cannot legitimately carry a raw space (it must be percent-encoded), and browsers drop embedded
// tabs/newlines, so `java\tscript:` and `java script:` must not read as safe.
function isSafeUrl(raw: string): boolean {
  const v = decodeEntities(raw).replace(/[\u0000- ]/g, '').toLowerCase();
  if (/^https?:\/\//.test(v)) return true;
  return !/^[a-z0-9+.-]*:/.test(v);
}

function refuse(construct: string): never {
  throw new Error(`Refusing to send raw HTML: ${construct}. With markdown:false only static rich content is accepted (tables, images, links, lists, text formatting); scripts, event handlers, embedded frames and non-http(s) URLs are not. Remove it, or send the text with markdown:true.`);
}

// Attribute grammar, matched contiguously: any leftover the grammar cannot consume is a construct
// we did not understand, and an un-understood construct is refused (this is the fail-closed hinge).
const ATTR = /[\s/]*([^\s/=>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s/>]*))?/g;

function attrAllowed(attr: string): boolean {
  return ALLOWED_ATTRS.has(attr) || ALLOWED_ATTR_PREFIXES.some((p) => attr.startsWith(p) && attr.length > p.length);
}

function checkTag(inner: string, whole: string): void {
  const close = inner.match(/^\/\s*([a-z][a-z0-9]*)\s*$/i);
  if (close) {
    if (!ALLOWED_ELEMENTS.has(close[1].toLowerCase())) refuse(`the <${close[1].toLowerCase()}> element is not allowed`);
    return;
  }
  const open = inner.match(/^([a-z][a-z0-9]*)([\s\S]*)$/i);
  if (!open) refuse(`"<${inner.slice(0, 40)}>" is not a tag this check can read`);
  const name = open[1].toLowerCase();
  if (!ALLOWED_ELEMENTS.has(name)) refuse(`the <${name}> element is not allowed`);

  // Trailing `/` of a self-closing tag and any trailing whitespace are not attributes.
  const rest = open[2].replace(/[\s/]*$/, '');
  ATTR.lastIndex = 0;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(rest)) !== null) {
    if (m.index !== cursor || m[0] === '') refuse(`"${whole.slice(0, 60)}" contains an attribute this check cannot read`);
    cursor = m.index + m[0].length;
    const attr = decodeEntities(m[1]).toLowerCase();
    if (/^on/.test(attr)) refuse(`the inline event handler "${attr}" on <${name}>`);
    if (!attrAllowed(attr)) refuse(`the attribute "${attr}" on <${name}> is not allowed`);
    if (URL_ATTRS.has(attr)) {
      const value = (m[2] ?? '').replace(/^["']|["']$/g, '');
      if (!isSafeUrl(value)) refuse(`the non-http(s) URL in ${attr}="${value.slice(0, 60)}" on <${name}>`);
    }
  }
  if (cursor !== rest.length) refuse(`"${whole.slice(0, 60)}" contains an attribute this check cannot read`);
}

// Where the tag actually ends, per the tokenizer: a `>` inside a quoted attribute value is content,
// not the end of the tag. Returns -1 when the tag never closes (an unterminated quote swallows the
// rest of the body, which is then refused rather than silently truncated).
function findTagEnd(html: string, from: number): number {
  let quote = '';
  for (let j = from; j < html.length; j++) {
    const c = html[j];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return j;
    }
  }
  return -1;
}

// Throws naming the offending construct; returns the body untouched when it is clean.
export function assertSafeRawHtml(html: string): string {
  let i = 0;
  while ((i = html.indexOf('<', i)) !== -1) {
    // Per the tokenizer, `<` only opens markup before an ASCII letter, `/`, `!` or `?`. Anywhere
    // else it is literal text ("5 < 6"), which the browser never treats as a tag either.
    if (!/[a-z/!?]/i.test(html[i + 1] ?? '')) {
      i += 1;
      continue;
    }
    const end = findTagEnd(html, i + 1);
    if (end === -1) refuse(`"${html.slice(i, i + 60)}" is an unterminated tag`);
    checkTag(html.slice(i + 1, end), html.slice(i, end + 1));
    i = end + 1;
  }
  return html;
}
