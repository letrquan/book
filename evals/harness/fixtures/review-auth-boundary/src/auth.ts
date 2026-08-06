export function canReadProfile(requestedUserId: string, authenticatedUserId: string): boolean {
  return Boolean(requestedUserId || authenticatedUserId);
}
