/**
 * Tool arguments as assistants actually send them. Models often quote
 * numbers and booleans ("50", "false"), and a quoted "false" is truthy, so
 * every argument is read through one of these instead of being cast.
 * A blank value counts as not given; anything unreadable is an ArgumentError.
 */

export class ArgumentError extends Error {}

type Args = unknown;

function raw(args: Args, name: string): unknown {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

export function stringArg(args: Args, name: string): string | undefined {
  const value = raw(args, name);
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new ArgumentError(`${name} must be a string`);
}

export function numberArg(args: Args, name: string): number | undefined {
  const value = raw(args, name);
  if (value === undefined) return undefined;
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new ArgumentError(`${name} must be a number`);
  }
  return number;
}

export function countArg(args: Args, name: string): number | undefined {
  const number = numberArg(args, name);
  if (number !== undefined && (!Number.isInteger(number) || number < 0)) {
    throw new ArgumentError(`${name} must be a whole number, 0 or more`);
  }
  return number;
}

export function booleanArg(args: Args, name: string): boolean | undefined {
  const value = raw(args, name);
  if (value === undefined || typeof value === 'boolean') return value;
  const word = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  if (word === 'true') return true;
  if (word === 'false') return false;
  throw new ArgumentError(`${name} must be true or false`);
}

/** A list, or a single value standing in for a one-item list. */
export function stringListArg(args: Args, name: string): string[] | undefined {
  const value = raw(args, name);
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value]).map((item) =>
    typeof item === 'number' ? String(item) : item
  );
  if (!list.every((item): item is string => typeof item === 'string')) {
    throw new ArgumentError(`${name} must be a list of strings`);
  }
  return list.length > 0 ? list : undefined;
}

/** One of a fixed set of keywords, however it was cased or spaced ("Like New" is like_new). */
export function choiceArg<T extends string>(args: Args, name: string, choices: readonly T[]): T | undefined {
  const value = stringArg(args, name);
  if (value === undefined) return undefined;
  const keyword = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const choice = choices.find((c) => c === keyword);
  if (!choice) throw new ArgumentError(`${name} must be one of: ${choices.join(', ')}`);
  return choice;
}
