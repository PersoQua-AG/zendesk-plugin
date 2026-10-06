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
import { parse, Tokenizer } from 'parse5';

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
const GLOBAL_ATTR_PREFIXES = ['aria-'];

// Per-element attributes. Scoping these to the element rather than keeping one flat list is what
// makes the allowlist mean what it says: flat, it let `<p datetime>` and `<img start>` through and
// promised a precision it did not have. With the parse tree in hand the element name is free.
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
// This is deliberately the token stream and not the tree: an insertion mode may drop a start tag
// (<frameset>) or merge its attributes onto an element that already exists (<html>, <body>), and in
// both cases the tree for THIS string shows nothing while the host page is changed. The token
// stream is insertion-mode independent, so it states what the author asked for either way.
// Exported because this is the half that has to agree with the browser, and a test asserts that
// agreement against expectations derived by hand from the HTML spec.
export function parseTags(html: string): SeenTag[] {
  const seen: SeenTag[] = [];
  // A body ending mid-construct is refused even though the parser just drops the half-tag: this
  // body is not rendered alone, it is inserted into a Help Center page, and the markup that follows
  // it there would finish the tag — attribute values and all. Only the `eof-*` codes matter; the
  // other parse errors are recoveries a browser performs identically. The same premise is why the
  // check reads the token stream and parses as a document: the context is a page, not a fragment.
  const atEof: string[] = [];
  const noop = (): void => undefined;
  const tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: false },
    {
      onStartTag: (t: { tagName: string; attrs: { name: string; value: string }[] }) => {
        // NOTE: lowercasing drops an attribute's namespace prefix, so `xlink:href` would arrive as
        // `xlink:href` here but a foreign-content parse could yield a bare `href`. Unreachable while
        // `svg` and `math` are refused at the element name; revisit before allowing foreign content.
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

// Elements the DOCUMENT parse materialises, which is the mode an article body is rendered in. Its
// job here is the half the token stream cannot give: tags the tree builder implies on its own
// (a <tbody> inside a table), and attributes an insertion mode merges onto the page's own <html> or
// <body>. The scaffold below contributes html/head/body with NO attributes, so any attribute found
// on them came from the body and would land on the host page's elements.
const SCAFFOLD = new Set(['html', 'head', 'body']);

export function documentElements(html: string): SeenTag[] {
  const seen: SeenTag[] = [];
  const walk = (node: { childNodes?: unknown[] }): void => {
    for (const raw of node.childNodes ?? []) {
      const child = raw as { nodeName: string; tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: unknown[] };
      if (child.tagName !== undefined) {
        const tag = child.tagName.toLowerCase();
        const attrs = (child.attrs ?? []).map((a) => [a.name.toLowerCase(), a.value] as [string, string]);
        if (SCAFFOLD.has(tag)) {
          // Not "an attribute on <body>" but "an attribute the page would adopt onto its own body".
          for (const [attr] of attrs) refuse(`the attribute "${attr}", which a page merges onto its own <${tag}> element`);
        } else {
          seen.push({ tag, attrs });
        }
      }
      walk(child);
    }
  };
  walk(parse(`<!DOCTYPE html><html><body>${html}</body></html>`) as { childNodes?: unknown[] });
  return seen;
}

function attrAllowed(tag: string, attr: string): boolean {
  if (GLOBAL_ATTRS.has(attr) || GLOBAL_ATTR_PREFIXES.some((p) => attr.startsWith(p) && attr.length > p.length)) return true;
  return (ELEMENT_ATTRS[tag] ?? []).includes(attr);
}

// Throws naming the offending construct; returns the body untouched when it is clean.
export function assertSafeRawHtml(html: string): string {
  // Both views, because neither alone is complete: the token stream states what the author wrote
  // even when an insertion mode discards it, the document parse states what a page actually builds
  // including tags implied by the tree builder.
  const tags = [...parseTags(html), ...documentElements(html)];
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
