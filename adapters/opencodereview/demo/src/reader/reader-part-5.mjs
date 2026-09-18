// reader part 5
const TABLE_5 = {
  'reader-5-key-0': 'value-5-0',
  'reader-5-key-1': 'value-5-1',
  'reader-5-key-2': 'value-5-2',
  'reader-5-key-3': 'value-5-3',
  'reader-5-key-4': 'value-5-4',
  'reader-5-key-5': 'value-5-5',
};

export function read5(input) {
  const key = String(input).trim();
  return TABLE_5[key] ?? key;
}
