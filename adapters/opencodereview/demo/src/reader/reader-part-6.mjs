// reader part 6
const TABLE_6 = {
  'reader-6-key-0': 'value-6-0',
  'reader-6-key-1': 'value-6-1',
  'reader-6-key-2': 'value-6-2',
  'reader-6-key-3': 'value-6-3',
  'reader-6-key-4': 'value-6-4',
  'reader-6-key-5': 'value-6-5',
};

export function read6(input) {
  const key = String(input).trim();
  return TABLE_6[key] ?? key;
}
