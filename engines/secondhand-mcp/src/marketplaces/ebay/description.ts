import { convert, type FormatCallback, type HtmlToTextOptions } from 'html-to-text';

const MARKUP = /<[a-z!\/]/i;
// Real descriptions run to tens of kilobytes; eBay allows 500K, and the parser
// slows sharply on long unclosed nesting. Cutting here rather than through the
// library's own limit keeps it from logging a warning on every long description.
const MAX_DESCRIPTION_CHARS = 100_000;
// Every tag a seller leaves unclosed nests the rest of the description one
// level deeper, so old templates run to hundreds of levels. The walk exhausts
// Node's default stack at roughly 3,000 to 4,000 levels (measured with these
// formatters); stopping well short keeps the text instead of the raw fallback.
const MAX_NESTING_DEPTH = 1_000;

function insideListItem(elem: Parameters<FormatCallback>[0]): boolean {
  for (let parent = elem.parent; parent; parent = parent.parent) {
    if (parent.name === 'li') return true;
  }
  return false;
}

function soleParagraphOfCell(elem: Parameters<FormatCallback>[0]): boolean {
  const cell = elem.parent;
  if (cell?.name !== 'td' && cell?.name !== 'th') return false;
  return cell.children.every((child) => child === elem || (child.type === 'text' && !child.data?.trim()));
}

// Seller templates wrap every list item's text, and every spec table cell's,
// in a <p>; as its own block it would push each bullet a blank line from the
// next and put a spec's label and value on separate lines.
const paragraphUnlessInline: FormatCallback = (elem, walk, builder, formatOptions) => {
  if (insideListItem(elem) || soleParagraphOfCell(elem)) return walk(elem.children, builder);
  builder.openBlock({ leadingLineBreaks: formatOptions.leadingLineBreaks ?? 2 });
  walk(elem.children, builder);
  builder.closeBlock({ trailingLineBreaks: formatOptions.trailingLineBreaks ?? 2 });
};

// Cells read in order, one row per line. Seller templates lay out whole pages
// in tables; aligning columns would pad a sidebar to the description's width.
const cellThenSpace: FormatCallback = (elem, walk, builder) => {
  walk(elem.children, builder);
  builder.addInline(' ');
};

const WHITESPACE = ' \t\r\n\f\u200b\u00a0';

const HTML: HtmlToTextOptions = {
  wordwrap: false,
  limits: { maxDepth: MAX_NESTING_DEPTH },
  whitespaceCharacters: WHITESPACE,
  formatters: { paragraphUnlessInline, cellThenSpace },
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'title', format: 'skip' },
    { selector: 'p', format: 'paragraphUnlessInline', options: { leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({ selector, options: { uppercase: false } })),
    { selector: 'ul', options: { itemPrefix: '- ' } },
    { selector: 'table', format: 'block' },
    { selector: 'tr', format: 'block', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: 'td', format: 'cellThenSpace' },
    { selector: 'th', format: 'cellThenSpace' },
  ],
};

const PLAIN: HtmlToTextOptions = { wordwrap: false, preserveNewlines: true, whitespaceCharacters: WHITESPACE };

function optionsFor(description: string): HtmlToTextOptions {
  if (MARKUP.test(description)) return HTML;
  return PLAIN;
}

/** eBay item descriptions are the seller's own HTML, often kilobytes of inline
 *  styling around a few sentences. The assistant gets the sentences. */
export function descriptionText(html: string): string {
  const description = html.slice(0, MAX_DESCRIPTION_CHARS);
  let text: string;
  try {
    text = convert(description, optionsFor(description));
  } catch (err) {
    // Unconverted is how descriptions were served before; never worse than that.
    console.error('[ebay] description not converted:', err instanceof Error ? err.message : String(err));
    return html;
  }
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}
