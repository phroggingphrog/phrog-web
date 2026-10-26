import { describe, expect, it, vi } from 'vitest';

vi.mock('html-to-text', () => ({
  convert: () => {
    throw new RangeError('Maximum call stack size exceeded');
  },
}));

import { descriptionText } from '../src/marketplaces/ebay/description.js';

describe('descriptionText when the converter fails', () => {
  it('gives back the description as the seller wrote it, and says why in the log', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(descriptionText('<p>Oak table</p>')).toBe('<p>Oak table</p>');
    expect(error).toHaveBeenCalledWith('[ebay] description not converted:', 'Maximum call stack size exceeded');
  });
});
