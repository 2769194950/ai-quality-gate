// reader part 3
const TABLE_3 = {
  'reader-3-key-0': 'value-3-0',
  'reader-3-key-1': 'value-3-1',
  'reader-3-key-2': 'value-3-2',
  'reader-3-key-3': 'value-3-3',
  'reader-3-key-4': 'value-3-4',
  'reader-3-key-5': 'value-3-5',
};

export function read3(input) {
  const key = String(input).trim();
  return TABLE_3[key] ?? key;
}
