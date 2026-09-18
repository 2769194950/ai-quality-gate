export function toUserDto(row) {
  // 若 repository 字段改名（created_at → createdAt），此处静默产生 undefined
  return {
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
