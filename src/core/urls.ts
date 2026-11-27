/**
 * Error messages and logs must not carry API keys. Tile URLs put keys in the query string
 * (`?apikey=…`, `?access_token=…`), so the query of every URL in a message is cut off.
 * Keys placed in the path cannot be told apart from the rest of the URL — avoid such services
 * or wrap them in a proxy.
 */

/** Characters that end a URL in running text. */
const isUrlEnd = (c: string) => c <= ' ' || c === '"' || c === "'" || c === '<' || c === '>';
const isSchemeChar = (c: string) => /[A-Za-z0-9+.-]/.test(c);
const isTrailingPunct = (c: string) => '.,;:!)'.includes(c);

/**
 * `https://t/1/2/3.png?apikey=secret` → `https://t/1/2/3.png?…` (also for several URLs in a
 * text). A plain forward scan without regular-expression backtracking: linear time on any input,
 * so it is safe to run on whatever ends up in an error message.
 */
export function redactUrls(text: string): string {
    let out = '';
    let copied = 0; // text before this index is already in `out`
    let from = 0;
    for (;;) {
        const sep = text.indexOf('://', from);
        if (sep < 0) break;
        // The scheme must be letters/digits/+.- directly before "://", starting with a letter.
        let s = sep;
        while (s > copied && isSchemeChar(text[s - 1])) s--;
        while (s < sep && !/[A-Za-z]/.test(text[s])) s++;
        let i = sep + 3;
        if (s === sep) {
            from = i;
            continue;
        }
        // Path: up to "?", "#" or the end of the URL.
        while (i < text.length && !isUrlEnd(text[i]) && text[i] !== '?' && text[i] !== '#') i++;
        if (text[i] !== '?') {
            from = i;
            continue;
        }
        const q = i + 1;
        let end = q;
        while (end < text.length && !isUrlEnd(text[end]) && text[end] !== '#') end++;
        // Punctuation right after the URL (a comma or full stop in a sentence) is kept.
        let keep = end;
        while (keep > q && isTrailingPunct(text[keep - 1])) keep--;
        out += text.slice(copied, q) + '…' + text.slice(keep, end);
        copied = from = end;
    }
    return out + text.slice(copied);
}

/** Message of an error-like value with URLs redacted, for logging. */
export function errorText(err: unknown): string {
    const msg = err instanceof Error
        ? `${err.name}: ${err.message}`
        : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
    return redactUrls(msg);
}
