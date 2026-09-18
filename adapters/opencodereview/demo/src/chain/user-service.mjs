import { UserRepository } from './user-repository.mjs';
import { toUserDto } from './user-mapper.mjs';

export class UserService {
  constructor(repository = new UserRepository()) {
    this.repository = repository;
  }

  findById(id) {
    // 注入点：service 依赖 repository 与 mapper 的具体形状
    const row = this.repository.selectById(id);
    return row ? toUserDto(row) : null;
  }
}
