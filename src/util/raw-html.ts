// src/util/raw-html.ts
// Dependency-free, fail-closed check for `markdown:false` bodies (#60). The raw path advertises
// rich content (tables, images, nested lists) and never promised active content, so this allows an
// explicit element/attribute set and refuses everything else BEFORE the request — a clean body is
// passed on byte-identically. Allowlist, not blocklist: an unparseable or unknown construct is
// refused rather than guessed at, which is what makes entity- and whitespace-based evasion moot.

// Rich-content set: what markdownToHtml emits, plus tables/figures/definition lists.
const ALLOWED_ELEMENTS = new Set([
  'p', 'br', 'hr', 'div', 'span', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'a', 'img', 'figure', 'figcaption',
  'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark',
]);

// `style` is absent on purpose: a style attribute can carry a URL and is not needed for the
// advertised content. Every `on*` handler is excluded by construction (not in this set).
const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'id', 'class', 'lang', 'dir',
  'width', 'height', 'colspan', 'rowspan', 'headers', 'scope', 'span', 'align', 'rel', 'loading',
]);

const URL_ATTRS = new Set(['href', 'src']);

const NAMED = new Map([['amp', '&'], ['colon', ':'], ['tab', '\t'], ['newline', '\n'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

// Decoded twice so a double-encoded scheme (`&amp;#58;`) resolves to the same `:` the browser sees.
function decodeEntities(s: string): string {
  const once = (t: string) => t
    .replace(/&#x([0-9a-f]+);?/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);?/g, (m, d) => safeChar(parseInt(d, 10), m))
    .replace(/&([a-z]+);?/gi, (m, n) => NAMED.get(n.toLowerCase()) ?? m);
  return once(once(s));
}

function safeChar(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

// http(s) or scheme-relative only. Anything carrying another scheme — after entity decoding and
// after stripping the control characters browsers ignore inside a URL — is refused.
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

  const rest = open[2].replace(/\/\s*$/, '');
  ATTR.lastIndex = 0;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(rest)) !== null) {
    if (m.index !== cursor || m[0] === '') refuse(`"${whole.slice(0, 60)}" contains an attribute this check cannot read`);
    cursor = m.index + m[0].length;
    const attr = decodeEntities(m[1]).toLowerCase();
    if (/^on/.test(attr)) refuse(`the inline event handler "${attr}" on <${name}>`);
    if (!ALLOWED_ATTRS.has(attr)) refuse(`the attribute "${attr}" on <${name}> is not allowed`);
    if (URL_ATTRS.has(attr)) {
      const value = (m[2] ?? '').replace(/^["']|["']$/g, '');
      if (!isSafeUrl(value)) refuse(`the non-http(s) URL in ${attr}="${value.slice(0, 60)}" on <${name}>`);
    }
  }
  if (cursor !== rest.length) refuse(`"${whole.slice(0, 60)}" contains an attribute this check cannot read`);
}

// Throws naming the offending construct; returns the body untouched when it is clean.
export function assertSafeRawHtml(html: string): string {
  let i = 0;
  while ((i = html.indexOf('<', i)) !== -1) {
    const end = html.indexOf('>', i);
    // ponytail: an unterminated tag — and a `>` inside a quoted attribute value, which splits the
    // tag early — both land here or in checkTag and are refused. Parse with a real HTML parser if
    // authors ever legitimately need `>` inside an attribute.
    if (end === -1) refuse(`"${html.slice(i, i + 60)}" is an unterminated tag`);
    checkTag(html.slice(i + 1, end), html.slice(i, end + 1));
    i = end + 1;
  }
  return html;
}
