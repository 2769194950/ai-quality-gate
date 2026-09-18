export class UserRepository {
  constructor(db = null) {
    this.db = db;
  }

  selectById(id) {
    // 夹具：真实实现应查询数据库；此处返回固定行以保持离线确定性
    return { id, name: 'fixture-user', created_at: '2024-01-01T00:00:00Z' };
  }
}
