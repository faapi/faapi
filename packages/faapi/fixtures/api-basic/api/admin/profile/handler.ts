export function GET(user: any) {
  return { name: user.name, role: user.role };
}
