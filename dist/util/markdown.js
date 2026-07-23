// src/util/markdown.ts
// Minimal, dependency-free Markdown→HTML for Zendesk comment/article bodies.
// Escapes first (XSS-safe); links restricted to http(s) to block javascript: URIs.
// Quotes are escaped too, so an attacker-controlled link URL cannot break out of the
// href="…" attribute to inject an event handler (e.g. "onmouseover=).
function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function inline(text) {
    return escapeHtml(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // Non-greedy so a single `*` inside a bold span (e.g. `**a *b* c**`) no longer
        // leaks a literal `**`; italics are applied afterwards inside the captured text.
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
        // href source is quote-escaped upstream, so $2 cannot contain a raw " to escape the attribute.
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
export function markdownToHtml(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inList = false;
    for (const line of lines) {
        const listItem = line.match(/^\s*[-*]\s+(.*)$/);
        if (listItem) {
            if (!inList) {
                out.push('<ul>');
                inList = true;
            }
            out.push(`<li>${inline(listItem[1])}</li>`);
            continue;
        }
        if (inList) {
            out.push('</ul>');
            inList = false;
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            const level = heading[1].length;
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
            continue;
        }
        if (line.trim() === '')
            continue;
        out.push(`<p>${inline(line)}</p>`);
    }
    if (inList)
        out.push('</ul>');
    return out.join('\n');
}
