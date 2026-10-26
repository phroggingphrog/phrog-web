import { describe, expect, it, vi } from 'vitest';
import { descriptionText } from '../src/marketplaces/ebay/description.js';

describe('descriptionText', () => {
  it.each([
    'Works great, minor scuffs on the lid.',
    'heart <3 this lamp',
    '',
  ])('passes plain text through unchanged: %j', (plain) => {
    expect(descriptionText(plain)).toBe(plain);
  });

  it('keeps a plain description\'s line breaks, at most one blank line in a row', () => {
    expect(descriptionText('Line one\n\n\nLine two   with  spaces')).toBe('Line one\n\nLine two with spaces');
  });

  it('turns a non-breaking space in a plain description into an ordinary one', () => {
    expect(descriptionText('Size 10&nbsp;&nbsp;fits')).toBe('Size 10 fits');
  });

  it('decodes entities in a description that has no markup', () => {
    expect(descriptionText('Tom &amp; Jerry box set, caf&eacute; edition')).toBe('Tom & Jerry box set, café edition');
  });

  it('reads a Google Docs seller template, list items wrapped in paragraphs, as bullets', () => {
    const html =
      '<div style="text-align: center;"><font size="6"><b>Nintendo Switch OLED 64GB ✈️</b></font></div><div><br></div>' +
      '<div><p dir="ltr" style="line-height: 1.2;"><span style="font-weight: 700;">Item Specifics</span></p>' +
      '<ul style="margin-top: 0px;"><li dir="ltr" aria-level="1"><p dir="ltr" role="presentation"><span>WiFI | Internet Connectable</span></p></li>' +
      '<li dir="ltr" aria-level="1"><p dir="ltr" role="presentation"><span>7" OLED Touchscreen Display</span></p></li></ul>' +
      '<p dir="ltr"><span>Returns</span></p><p><span>Same condition &amp; packaging.</span></p></div>';

    expect(descriptionText(html)).toBe(
      'Nintendo Switch OLED 64GB ✈️\n\nItem Specifics\n\n- WiFI | Internet Connectable\n- 7" OLED Touchscreen Display\n\nReturns\n\nSame condition & packaging.',
    );
  });

  it('keeps link text but not the address, and leaves images out', () => {
    expect(descriptionText('<p><a href="https://seller.example/more">See more photos</a> <img src="a.jpg" alt="front"></p>')).toBe('See more photos');
  });

  it('keeps a dash the seller typed on its own line', () => {
    expect(descriptionText('Price<br>-<br>Shipping')).toBe('Price\n-\nShipping');
  });

  // Sixteen times the markup should take about sixteen times as long; quadratic
  // work takes about 256 times. The sizes alternate and each keeps its fastest
  // run, so a busy machine slows both alike.
  const growth = (unit: string) => {
    const small = unit.repeat(Math.ceil(31_250 / unit.length));
    const large = unit.repeat(Math.ceil(500_000 / unit.length));
    const time = (html: string) => {
      const started = performance.now();
      descriptionText(html);
      return performance.now() - started;
    };
    time(small);
    time(large);
    let fastestSmall = Infinity;
    let fastestLarge = Infinity;
    for (let run = 0; run < 7; run++) {
      fastestSmall = Math.min(fastestSmall, time(small));
      fastestLarge = Math.min(fastestLarge, time(large));
    }
    return fastestLarge / fastestSmall;
  };

  it.each([
    ['a Google Docs list', '<ul><li><p style="margin:0"><span style="font-size:12pt">Item detail line</span></p></li></ul><p>Paragraph &amp; more</p>'],
    ['one enormous line of cells', '<td>cell</td>'],
    ['unclosed comments', '<!--x'],
    ['tags that never close', '<b x'],
    ['an unclosed script', '<script>x'],
    ['declarations that never close', '<!doctype x'],
    ['heads that never close', '<head>x'],
  ])('stays fast up to eBay\'s 500,000-character limit on %s', (_shape, unit) => {
    expect(growth(unit)).toBeLessThan(64);
  });

  it('reads a description past 100,000 characters without warning on every conversion', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    descriptionText(`<p>${'word '.repeat(40_000)}</p>`);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reads the first 100,000 characters of a description at eBay\'s limit', () => {
    const item = '<li><p style="margin:0"><span>Item detail line</span></p></li>';
    const text = descriptionText(`<ul>${item.repeat(Math.ceil(500_000 / item.length))}</ul>`);
    expect(text.startsWith('- Item detail line\n- Item detail line')).toBe(true);
    expect(text.length).toBeLessThan(100_000);
  });

  it('reads to the end of a description whose tags are never closed', () => {
    const html = Array.from({ length: 130 }, (_, i) => `<font>Line ${i + 1}<br>`).join('');
    const text = descriptionText(html);
    expect(text.endsWith('Line 129\nLine 130')).toBe(true);
  });

  it('drops an unclosed comment, script or declaration to the end, as a browser does', () => {
    expect(descriptionText('<p>Oak table</p><!-- seller note')).toBe('Oak table');
    expect(descriptionText('<p>Oak table</p><script>track(')).toBe('Oak table');
  });

  it('reads a head left open, and lookalike closers, the way a browser does', () => {
    expect(descriptionText('<html><head><meta charset="utf-8"><title>Store v2</title><body><p>Oak table, solid</p></body></html>')).toBe(
      'Oak table, solid',
    );
    expect(descriptionText('<head><p>Oak table</p>')).toBe('Oak table');
    expect(descriptionText('<head><title>x</title></header><p>shown</p></head><p>Oak</p>')).toBe('shown\n\nOak');
    expect(descriptionText('<style>p{}</styles><p>not shown</p></style><p>Oak</p>')).toBe('Oak');
  });

  it("reads Word's curly quotes and dashes the way a browser does", () => {
    expect(descriptionText('<p>&#147;Mint&#148; &#150; seller&#146;s &#128;5 &#153;</p>')).toBe('“Mint” – seller’s €5 ™');
  });

  it('keeps one space between words split by empty tags and after a bullet', () => {
    expect(descriptionText('<span>Solid </span><i></i> oak')).toBe('Solid oak');
    expect(descriptionText('<ul><li> Charger included</li></ul>')).toBe('- Charger included');
  });

  it('decodes the accented letters sellers type', () => {
    expect(descriptionText('<p>Cr&egrave;me br&ucirc;l&eacute;e set, &Agrave; la carte, Stra&szlig;e &ntilde;</p>')).toBe(
      'Crème brûlée set, À la carte, Straße ñ',
    );
  });

  it('leaves out the head of a full-page template', () => {
    const html = '<html><head><title>My eBay Store Template v2</title><meta charset="utf-8"></head><body><p>Oak table</p></body></html>';
    expect(descriptionText(html)).toBe('Oak table');
  });

  it('turns inline-styled seller markup into plain lines', () => {
    const html =
      '<div style="font-family:Arial"><font size="4"><b>Vintage   Lamp</b></font>\n' +
      '  <div><span style="color:red">Brass</span> base</div></div>';

    expect(descriptionText(html)).toBe('Vintage Lamp\nBrass base');
  });

  it('separates paragraphs with one blank line and honours line breaks', () => {
    const html = '<p>First paragraph.</p><p>Second<br>line two<BR/>line three</p>';

    expect(descriptionText(html)).toBe('First paragraph.\n\nSecond\nline two\nline three');
  });

  it('collapses runs of blank lines to one', () => {
    expect(descriptionText('a<br><br><br><br><br>b')).toBe('a\n\nb');
  });

  it('keeps a spec table\'s label and value on one line when each cell wraps its text in a paragraph', () => {
    const html =
      '<p>Item Specifications</p><table><tr><td><p>Make</p></td><td><p>Nintendo</p></td></tr>' +
      '<tr><td><p>Model</p></td><td><p>Switch OLED</p></td></tr></table><p>Ships fast</p>';
    expect(descriptionText(html)).toBe('Item Specifications\n\nMake Nintendo\nModel Switch OLED\n\nShips fast');
  });

  it('keeps a cell\'s text apart from a paragraph beside it', () => {
    expect(descriptionText('<table><tr><td>Condition:<p>Used</p></td></tr></table>')).toBe('Condition:\n\nUsed');
    expect(descriptionText('<table><tr><td><p>Make</p>Nintendo</td></tr></table>')).toBe('Make\n\nNintendo');
  });

  it('keeps one line per heading and table row, cells side by side', () => {
    const html =
      '<h2>Specs</h2><table><tr><td>Brand</td><td>Nike</td></tr>' +
      '<tr><th>Size</th><td>10</td></tr></table>';

    expect(descriptionText(html)).toBe('Specs\n\nBrand Nike\nSize 10');
  });

  it('reads a seller\'s side-by-side layout table in order, without padding one column to the other', () => {
    const description = 'Solid oak dining table, seats six. '.repeat(20).trim();
    const html =
      `<table><tr><td><p>Description</p><p>${description}</p></td>` +
      '<td><p>Shipping</p><p>Ships in 1 day</p></td></tr></table>';
    const text = descriptionText(html);
    expect(text).toBe(`Description\n\n${description}\n\nShipping\n\nShips in 1 day`);
    expect(text).not.toMatch(/ {3,}/);
  });

  it('prefixes list items and indents nested lists', () => {
    const html =
      'Includes:<ul><li>Console</li><li>Cables<ul><li>HDMI</li><li>Power</li></ul></li>' +
      '<li>Manual</li></ul><ol><li>Tested</li></ol>Ships fast';

    expect(descriptionText(html)).toBe(
      'Includes:\n- Console\n- Cables\n  - HDMI\n  - Power\n- Manual\n\n 1. Tested\n\nShips fast',
    );
  });

  it('decodes named and numeric entities without re-reading them as markup', () => {
    const html =
      '<p>Tom &amp; Jerry &ndash; &quot;mint&quot; &#8220;boxed&#x201D; 5&#39;11 &copy;</p>' +
      '<p>&lt;b&gt;not bold&lt;/b&gt; &amp;lt; &unknown; &#99999999;</p>';

    expect(descriptionText(html)).toBe(
      'Tom & Jerry – "mint" “boxed” 5\'11 ©\n\n<b>not bold</b> &lt; &unknown; \ufffd',
    );
  });

  it('treats non-breaking spaces as ordinary spacing', () => {
    expect(descriptionText('<p>A&nbsp;&nbsp;&nbsp;B</p>')).toBe('A B');
  });

  it('drops style and script contents, comments and doctype', () => {
    const html =
      '<!DOCTYPE html><html><head><style type="text/css">.x { color: red; }</style>' +
      '<script>track("view")</script></head><body><!-- seller template v2 -->' +
      '<div>Real text</div><SCRIPT src="x.js"></SCRIPT></body></html>';

    expect(descriptionText(html)).toBe('Real text');
  });

  it('returns an empty string when the markup carries no text', () => {
    expect(descriptionText('<div><style>p{}</style><br></div>')).toBe('');
  });
});
