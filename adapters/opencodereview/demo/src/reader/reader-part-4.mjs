// reader part 4
const TABLE_4 = {
  'reader-4-key-0': 'value-4-0',
  'reader-4-key-1': 'value-4-1',
  'reader-4-key-2': 'value-4-2',
  'reader-4-key-3': 'value-4-3',
  'reader-4-key-4': 'value-4-4',
  'reader-4-key-5': 'value-4-5',
};

export function read4(input) {
  const key = String(input).trim();
  return TABLE_4[key] ?? key;
}
