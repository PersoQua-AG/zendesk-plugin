// src/util/raw-html.ts
// Validation-only check for `markdown:false` bodies (#60). The body that goes to Zendesk is always
// the ORIGINAL string — nothing here rewrites it — so the byte-identity acceptance test 2 requires
// is unaffected. What changes is only whether the write is allowed to happen at all.
//
// The structure comes from parse5, a WHATWG-compliant HTML parser (owner-approved fifth runtime
// dependency, see issue #60). Two hand-written scanners were tried first and both shipped a pass of
// the same class: each modelled a couple of tokenizer states, believed it could read what it was in
// fact reading wrongly, and so refused confidently rather than fail-closed. Deciding what is safe
// requires seeing the same elements and attributes the browser sees; that is a parser's job, and
// choosing "refuse" never avoided the parsing, it only made it invisible.
import { Tokenizer } from 'parse5';

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

// Attributes that are inert on every element: identity, language and accessibility metadata.
// `aria-*` is matched by prefix — an open family consumed by assistive technology, carrying no URL
// and unable to execute. `data-*` is deliberately NOT here: justifying it needs the premise that no
// page script reads it, and Guide themes do read data- hooks, which #60 explicitly leaves
// unverified. An unverifiable premise is not a reason to let something through.
const GLOBAL_ATTRS = new Set(['id', 'class', 'title', 'lang', 'dir', 'role']);

// Per-element attributes. Scoping these to the element rather than keeping one flat list is what
// makes the allowlist mean what it says: flat, it let `<p datetime>` and `<img start>` through and
// promised a precision it did not have. The element name comes free with each start tag token.
const ELEMENT_ATTRS: Record<string, string[]> = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  table: ['border', 'cellpadding', 'cellspacing', 'width', 'align'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  td: ['colspan', 'rowspan', 'headers', 'scope', 'align', 'width', 'height'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'align', 'width', 'height'],
  tr: ['align'],
  thead: ['align'],
  tbody: ['align'],
  tfoot: ['align'],
  ol: ['start', 'reversed', 'type'],
  ul: ['type'],
  time: ['datetime'],
  details: ['open'],
  div: ['align'],
  p: ['align'],
  blockquote: ['cite'],
};

// The only attributes whose value is fetched or navigated to, so the only ones needing a URL check.
const URL_ATTRS = new Set(['href', 'src']);

function refuse(construct: string): never {
  throw new Error(`Refusing to send raw HTML: ${construct}. With markdown:false only static rich content is accepted (tables, images, links, lists, text formatting); scripts, event handlers, embedded frames and non-http(s) URLs are not. Remove it, or send the text with markdown:true.`);
}

// http(s) or scheme-relative only. parse5 has already resolved character references, so no entity
// decoding is needed here. Everything from NUL to SPACE inclusive is stripped first: a URL cannot
// carry a raw space (it must be percent-encoded) and browsers drop embedded tabs and newlines, so
// neither `java\tscript:` nor `java script:` may read as safe.
function isSafeUrl(raw: string): boolean {
  const v = raw.replace(/[\u0000- ]/g, '').toLowerCase();
  if (/^https?:\/\//.test(v)) return true;
  return !/^[a-z0-9+.-]*:/.test(v);
}

export interface SeenTag {
  tag: string;
  attrs: [string, string][];
}

// Every start tag the AUTHOR WROTE, with the attribute names and values the tokenizer resolves.
// Deliberately the token stream and not a tree: an insertion mode may drop a start tag (<frameset>)
// or merge its attributes onto an element that already exists (<html>, <body>), and in both cases a
// tree built from THIS string shows nothing while the host page is changed. The token stream is
// insertion-mode independent, so it states what the author asked for either way.
//
// A tree view was carried alongside this for one round and is gone: every element in a tree comes
// from a token except {html, head, body, tbody}. The first three are not in ALLOWED_ELEMENTS, so
// writing them is caught here, and not writing them means a scaffold contributes them without
// attributes; tbody is allowed and carries none when implied. The tree builder never invents an
// attribute — the one spec operation that did (<isindex>) was removed in 2016. Two independent
// runs (66 and 108 bodies) found zero verdict divergences.
//
// WHEN THIS STOPS HOLDING, and a tree view has to be reconsidered: as soon as `html`, `head` or
// `body` goes on ALLOWED_ELEMENTS (the "not allowed, so caught here" half falls away), or as soon as
// a foreign-content element (`svg`, `math`) does. Foreign content is where the tree builder DOES
// rewrite attributes — `xlink:href`→`href`, `xml:lang`→`lang` — and it rewrites systematically from
// a name this list rejects to one it accepts, so a tree view would then be the PERMISSIVE one rather
// than a subset of this.
//
// KNOWN DEVIATION, fail-closed: a standalone Tokenizer never enters RAWTEXT/RCDATA, which only a
// tree builder switches it into. So inside `title`, `style`, `textarea`, `script`, `plaintext` and
// `noembed` an inner `<img src=x onerror=…>` is reported as a tag where a real parse reads it as
// text — and the refusal reason can differ too (`<title><img src=x` gives eof-in-tag, which a real
// RCDATA parse would not report). Harmless while all six containers are refused at the element
// name; whoever puts `style` on the allowlist — the most-requested false refusal — must revisit it.
// Exported because this is the half that has to agree with the browser, and a test asserts that
// agreement against expectations derived by hand from the HTML spec.
export function parseTags(html: string): SeenTag[] {
  const seen: SeenTag[] = [];
  // A body ending mid-construct is refused even though the parser just drops the half-tag: this
  // body is not rendered alone, it is inserted into a Help Center page, and the markup that follows
  // it there would finish the tag — attribute values and all. Only the `eof-*` codes matter; the
  // other parse errors are recoveries a browser performs identically. The same premise is why this
  // reads the token stream at all: the context is a page, not a fragment rendered on its own.
  const atEof: string[] = [];
  const noop = (): void => undefined;
  const tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: false },
    {
      onStartTag: (t: { tagName: string; attrs: { name: string; value: string }[] }) => {
        // Lowercasing keeps an attribute's namespace prefix as written (`xlink:href` stays
        // `xlink:href`), which is what the tokenizer emits; only foreign-content tree building would
        // adjust it, and this check never gets there.
        seen.push({ tag: t.tagName.toLowerCase(), attrs: t.attrs.map((a) => [a.name.toLowerCase(), a.value]) });
      },
      onComment: () => refuse('an HTML comment'),
      onDoctype: () => refuse('a doctype declaration'),
      onEndTag: noop,
      onEof: noop,
      onCharacter: noop,
      onNullCharacter: noop,
      onWhitespaceCharacter: noop,
      onParseError: (err: { code: string }) => {
        if (err.code.startsWith('eof-')) atEof.push(err.code);
      },
    } as never,
  );
  tokenizer.write(html, true);
  if (atEof.length > 0) refuse(`the body ends in the middle of a tag (${atEof[0]}), which the surrounding page would finish`);
  return seen;
}

function attrAllowed(tag: string, attr: string): boolean {
  if (GLOBAL_ATTRS.has(attr) || (attr.startsWith('aria-') && attr.length > 5)) return true;
  return (ELEMENT_ATTRS[tag] ?? []).includes(attr);
}

// Throws naming the offending construct; returns the body untouched when it is clean.
export function assertSafeRawHtml(html: string): string {
  const tags = parseTags(html);
  // Active constructs are named before merely-unknown ones. Both refuse, but when a tag carries an
  // event handler AND an attribute that is simply not on the list, the handler is what the author
  // needs told — a message naming the harmless half of the tag buries the reason.
  for (const { tag, attrs } of tags) {
    for (const [attr, value] of attrs) {
      // Every `on`-prefixed name is refused, including a non-handler like `once`. The wording says
      // the rule rather than asserting a claim about the attribute, which would be wrong for those.
      if (attr.startsWith('on')) refuse(`the attribute "${attr}" on <${tag}> — names beginning with "on" are refused as inline event handlers`);
      if (URL_ATTRS.has(attr) && !isSafeUrl(value)) refuse(`the non-http(s) URL in ${attr}="${value.slice(0, 60)}" on <${tag}>`);
    }
  }
  for (const { tag, attrs } of tags) {
    if (!ALLOWED_ELEMENTS.has(tag)) refuse(`the <${tag}> element is not allowed`);
    for (const [attr] of attrs) {
      if (!attrAllowed(tag, attr)) refuse(`the attribute "${attr}" on <${tag}> is not allowed`);
    }
  }
  return html;
}
