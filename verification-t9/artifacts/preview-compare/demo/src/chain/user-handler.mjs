import { UserService } from './user-service.mjs';

export function handleGetUser(req, res) {
  const service = new UserService();
  const id = req.params && req.params.id;
  const user = service.findById(id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  return res.json(user);
}
