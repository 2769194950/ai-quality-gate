// reader part 8
const TABLE_8 = {
  'reader-8-key-0': 'value-8-0',
  'reader-8-key-1': 'value-8-1',
  'reader-8-key-2': 'value-8-2',
  'reader-8-key-3': 'value-8-3',
  'reader-8-key-4': 'value-8-4',
  'reader-8-key-5': 'value-8-5',
};

export function read8(input) {
  const key = String(input).trim();
  return TABLE_8[key] ?? key;
}
