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
import { parseFragment } from 'parse5';
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
const ELEMENT_ATTRS = {
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
function refuse(construct) {
    throw new Error(`Refusing to send raw HTML: ${construct}. With markdown:false only static rich content is accepted (tables, images, links, lists, text formatting); scripts, event handlers, embedded frames and non-http(s) URLs are not. Remove it, or send the text with markdown:true.`);
}
// http(s) or scheme-relative only. parse5 has already resolved character references, so no entity
// decoding is needed here. Everything from NUL to SPACE inclusive is stripped first: a URL cannot
// carry a raw space (it must be percent-encoded) and browsers drop embedded tabs and newlines, so
// neither `java\tscript:` nor `java script:` may read as safe.
function isSafeUrl(raw) {
    const v = raw.replace(/[\u0000- ]/g, '').toLowerCase();
    if (/^https?:\/\//.test(v))
        return true;
    return !/^[a-z0-9+.-]*:/.test(v);
}
// The tokenizer's view of the body: every element the browser would build, with the attribute names
// and values it would see. Exported because this is the half that has to agree with the browser,
// and a test asserts that agreement against expectations derived by hand from the HTML spec.
export function parseTags(html) {
    const seen = [];
    // A body ending mid-construct is refused even though the fragment parser simply drops the
    // half-tag: this body is not rendered alone, it is inserted into a Help Center page, and the
    // markup that follows it there would finish the tag — attribute values and all. Only the `eof-*`
    // codes matter; the other parse errors are recoveries a browser performs identically.
    const atEof = [];
    const walk = (node) => {
        for (const raw of node.childNodes ?? []) {
            const child = raw;
            if (child.tagName !== undefined) {
                seen.push({ tag: child.tagName.toLowerCase(), attrs: (child.attrs ?? []).map((a) => [a.name.toLowerCase(), a.value]) });
            }
            else if (child.nodeName === '#comment') {
                refuse('an HTML comment');
            }
            else if (child.nodeName === '#documentType') {
                refuse('a doctype declaration');
            }
            walk(child);
        }
    };
    const fragment = parseFragment(html, {
        onParseError: (err) => {
            if (err.code.startsWith('eof-'))
                atEof.push(err.code);
        },
    });
    if (atEof.length > 0)
        refuse(`the body ends in the middle of a tag (${atEof[0]}), which the surrounding page would finish`);
    walk(fragment);
    return seen;
}
function attrAllowed(tag, attr) {
    if (GLOBAL_ATTRS.has(attr) || GLOBAL_ATTR_PREFIXES.some((p) => attr.startsWith(p) && attr.length > p.length))
        return true;
    return (ELEMENT_ATTRS[tag] ?? []).includes(attr);
}
// Throws naming the offending construct; returns the body untouched when it is clean.
export function assertSafeRawHtml(html) {
    const tags = parseTags(html);
    // Active constructs are named before merely-unknown ones. Both refuse, but when a tag carries an
    // event handler AND an attribute that is simply not on the list, the handler is what the author
    // needs told — a message naming the harmless half of the tag buries the reason.
    for (const { tag, attrs } of tags) {
        for (const [attr, value] of attrs) {
            if (attr.startsWith('on'))
                refuse(`the inline event handler "${attr}" on <${tag}>`);
            if (URL_ATTRS.has(attr) && !isSafeUrl(value))
                refuse(`the non-http(s) URL in ${attr}="${value.slice(0, 60)}" on <${tag}>`);
        }
    }
    for (const { tag, attrs } of tags) {
        if (!ALLOWED_ELEMENTS.has(tag))
            refuse(`the <${tag}> element is not allowed`);
        for (const [attr] of attrs) {
            if (!attrAllowed(tag, attr))
                refuse(`the attribute "${attr}" on <${tag}> is not allowed`);
        }
    }
    return html;
}
