// reader part 7
const TABLE_7 = {
  'reader-7-key-0': 'value-7-0',
  'reader-7-key-1': 'value-7-1',
  'reader-7-key-2': 'value-7-2',
  'reader-7-key-3': 'value-7-3',
  'reader-7-key-4': 'value-7-4',
  'reader-7-key-5': 'value-7-5',
};

export function read7(input) {
  const key = String(input).trim();
  return TABLE_7[key] ?? key;
}
