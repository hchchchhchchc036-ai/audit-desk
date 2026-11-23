export function canRead(user, record) {
  return Boolean(user && record && user.id === record.ownerId);
}
