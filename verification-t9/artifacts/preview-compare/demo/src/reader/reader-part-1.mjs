// reader part 1
const TABLE_1 = {
  'reader-1-key-0': 'value-1-0',
  'reader-1-key-1': 'value-1-1',
  'reader-1-key-2': 'value-1-2',
  'reader-1-key-3': 'value-1-3',
  'reader-1-key-4': 'value-1-4',
  'reader-1-key-5': 'value-1-5',
};

export function read1(input) {
  const key = String(input).trim();
  return TABLE_1[key] ?? key;
}
