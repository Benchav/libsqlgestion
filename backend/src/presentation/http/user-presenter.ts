type UserLike = {
  id?: string;
  sub?: string;
  email: string;
  active?: boolean;
  createdAt?: Date | string;
  roles?: Array<any>;
};

function resolveRoles(user: UserLike, roles?: string[]) {
  if (roles) return roles;
  return (user.roles || [])
    .map((entry) => entry?.role?.name || entry?.name)
    .filter((role): role is string => typeof role === 'string' && role.length > 0);
}

export function presentUser(user: UserLike, roles?: string[]) {
  return {
    id: user.id || user.sub,
    email: user.email,
    active: Boolean(user.active),
    createdAt: user.createdAt,
    roles: resolveRoles(user, roles),
  };
}
