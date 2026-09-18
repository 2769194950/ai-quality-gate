// reader part 2
const TABLE_2 = {
  'reader-2-key-0': 'value-2-0',
  'reader-2-key-1': 'value-2-1',
  'reader-2-key-2': 'value-2-2',
  'reader-2-key-3': 'value-2-3',
  'reader-2-key-4': 'value-2-4',
  'reader-2-key-5': 'value-2-5',
};

export function read2(input) {
  const key = String(input).trim();
  return TABLE_2[key] ?? key;
}
